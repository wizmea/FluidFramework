/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IDisposable, ITelemetryLogger } from "@microsoft/fluid-common-definitions";
import {
    IComponentLoadable,
    IComponentRouter,
    IComponentRunnable,
    IRequest,
    IResponse,
} from "@microsoft/fluid-component-core-interfaces";
import { ChildLogger, Deferred, PerformanceEvent, PromiseTimer, Timer } from "@microsoft/fluid-common-utils";
import {
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    ISummaryConfiguration,
    MessageType,
} from "@microsoft/fluid-protocol-definitions";
import { ISummaryContext } from "@microsoft/fluid-driver-definitions";
import { ContainerRuntime, GenerateSummaryData } from "./containerRuntime";
import { RunWhileConnectedCoordinator } from "./runWhileConnectedCoordinator";
import { IClientSummaryWatcher, SummaryCollection } from "./summaryCollection";

// Send some telemetry if generate summary takes too long
const maxSummarizeTimeoutTime = 20000; // 20 sec
const maxSummarizeTimeoutCount = 5; // Double and resend 5 times

declare module "@microsoft/fluid-component-core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface IComponent extends Readonly<Partial<IProvideSummarizer>> { }
}

export interface IProvideSummarizer {
    readonly ISummarizer: ISummarizer;
}

export interface ISummarizer extends IComponentRouter, IComponentRunnable, IComponentLoadable {
    /**
     * Returns a promise that will be resolved with the next Summarizer after context reload
     */
    setSummarizer(): Promise<Summarizer>;
}

/**
 * Summarizer is responsible for coordinating when to send generate and send summaries.
 * It is the main entry point for summary work.
 */
export class Summarizer implements ISummarizer {
    public get IComponentRouter() { return this; }
    public get IComponentRunnable() { return this; }
    public get IComponentLoadable() { return this; }
    public get ISummarizer() { return this; }

    private readonly logger: ITelemetryLogger;
    private readonly runCoordinator: RunWhileConnectedCoordinator;
    private onBehalfOfClientId: string | undefined;
    private runningSummarizer?: RunningSummarizer;
    private systemOpListener?: (op: ISequencedDocumentMessage) => void;
    private opListener?: (error: any, op: ISequencedDocumentMessage) => void;
    private immediateSummary: boolean = false;
    public readonly summaryCollection: SummaryCollection;

    constructor(
        public readonly url: string,
        private readonly runtime: ContainerRuntime,
        private readonly configurationGetter: () => ISummaryConfiguration,
        // eslint-disable-next-line max-len
        private readonly generateSummaryCore: (full: boolean, safe: boolean) => Promise<GenerateSummaryData | undefined>,
        private readonly refreshLatestAck: (context: ISummaryContext, referenceSequenceNumber: number) => Promise<void>,
        summaryCollection?: SummaryCollection,
    ) {
        this.logger = ChildLogger.create(this.runtime.logger, "Summarizer");
        this.runCoordinator = new RunWhileConnectedCoordinator(runtime);
        if (summaryCollection) {
            // summarize immediately because we just went through context reload
            this.immediateSummary = true;
            this.summaryCollection = summaryCollection;
        } else {
            this.summaryCollection = new SummaryCollection(this.runtime.deltaManager.initialSequenceNumber);
        }
        this.runtime.deltaManager.inbound.on("op",
            (op) => this.summaryCollection.handleOp(op as ISequencedDocumentMessage));

        this.runtime.previousState.nextSummarizerD?.resolve(this);
    }

    public async run(onBehalfOf: string): Promise<void> {
        try {
            await this.runCore(onBehalfOf);
        } finally {
            // Cleanup after running
            this.dispose();
            if (this.runtime.connected) {
                this.stop("runEnded");
            }
        }
    }

    /**
     * Stops the summarizer from running.  This will complete
     * the run promise, and also close the container.
     * @param reason - reason code for stopping
     */
    public stop(reason?: string) {
        this.logger.sendTelemetryEvent({
            eventName: "StoppingSummarizer",
            onBehalfOf: this.onBehalfOfClientId,
            reason,
        });
        this.runCoordinator.stop();
        this.runtime.closeFn(`Summarizer: ${reason}`);
    }

    public async request(request: IRequest): Promise<IResponse> {
        return {
            mimeType: "fluid/component",
            status: 200,
            value: this,
        };
    }

    private async runCore(onBehalfOf: string): Promise<void> {
        this.onBehalfOfClientId = onBehalfOf;

        const startResult = await this.runCoordinator.waitStart();
        if (startResult.started === false) {
            this.logger.sendTelemetryEvent({
                eventName: "NotStarted",
                error: startResult.message,
                onBehalfOf,
            });
            return;
        }

        if (this.runtime.summarizerClientId !== this.onBehalfOfClientId) {
            // This calculated summarizer differs from parent
            // parent SummaryManager should prevent this from happening
            this.logger.sendErrorEvent({
                eventName: "ParentIsNotSummarizer",
                expectedSummarizer: this.runtime.summarizerClientId,
                onBehalfOf,
            });
            return;
        }

        // Initialize values and first ack (time is not exact)
        this.logger.sendTelemetryEvent({
            eventName: "RunningSummarizer",
            onBehalfOf,
            initSummarySeqNumber: this.summaryCollection.initialSequenceNumber,
        });

        const initialAttempt: ISummaryAttempt = {
            refSequenceNumber: this.summaryCollection.initialSequenceNumber,
            summaryTime: Date.now(),
        };

        // this.runCoordinator.waitStart in the beginning guaranteed that we are connected and has a clientId
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const clientId = this.runtime.clientId!;
        assert(clientId);

        const runningSummarizer = await RunningSummarizer.start(
            clientId,
            onBehalfOf,
            this.logger,
            this.summaryCollection.createWatcher(clientId),
            this.configurationGetter(),
            async (full: boolean, safe: boolean) => this.generateSummary(full, safe),
            this.runtime.deltaManager.referenceSequenceNumber,
            initialAttempt,
            this.immediateSummary,
        );
        this.runningSummarizer = runningSummarizer;

        this.immediateSummary = false;

        // Handle summary acks
        this.handleSummaryAcks().catch((error) => {
            this.logger.sendErrorEvent({ eventName: "HandleSummaryAckFatalError" }, error);
            this.stop("handleAckError");
        });

        // Listen for ops
        this.systemOpListener = (op: ISequencedDocumentMessage) => runningSummarizer.handleSystemOp(op);
        this.runtime.deltaManager.inbound.on("op", this.systemOpListener);

        this.opListener = (error: any, op: ISequencedDocumentMessage) => runningSummarizer.handleOp(error, op);
        this.runtime.on("batchEnd", this.opListener);

        await this.runCoordinator.waitStopped();
    }

    /**
     * Disposes of resources after running.  This cleanup will
     * clear any outstanding timers and reset some of the state
     * properties.
     */
    public dispose() {
        if (this.runningSummarizer) {
            this.runningSummarizer.dispose();
            this.runningSummarizer = undefined;
        }
        if (this.systemOpListener) {
            this.runtime.deltaManager.inbound.removeListener("op", this.systemOpListener);
        }
        if (this.opListener) {
            this.runtime.removeListener("batchEnd", this.opListener);
        }
    }

    public async setSummarizer(): Promise<Summarizer> {
        this.runtime.nextSummarizerD = new Deferred<Summarizer>();
        return this.runtime.nextSummarizerD.promise;
    }

    private async generateSummary(full: boolean, safe: boolean): Promise<GenerateSummaryData | undefined> {
        if (this.onBehalfOfClientId !== this.runtime.summarizerClientId) {
            // We are no longer the summarizer, we should stop ourself
            this.stop("parentNoLongerSummarizer");
            return undefined;
        }

        return this.generateSummaryCore(full, safe);
    }

    private async handleSummaryAcks() {
        let refSequenceNumber = this.summaryCollection.initialSequenceNumber;
        while (this.runningSummarizer) {
            try {
                const ack = await this.summaryCollection.waitSummaryAck(refSequenceNumber);
                refSequenceNumber = ack.summaryOp.referenceSequenceNumber;
                const context: ISummaryContext = {
                    proposalHandle: ack.summaryOp.contents.handle,
                    ackHandle: ack.summaryAckNack.contents.handle,
                };

                await this.refreshLatestAck(context, refSequenceNumber);
                refSequenceNumber++;
            } catch (error) {
                this.logger.sendErrorEvent({ eventName: "HandleSummaryAckError", refSequenceNumber }, error);
            }
        }
    }
}

/**
 * Data about a summary attempt
 */
export interface ISummaryAttempt {
    /**
     * Reference sequence number when summary was generated
     */
    readonly refSequenceNumber: number;

    /**
     * Time of summary attempt after it was sent
     */
    readonly summaryTime: number;

    /**
     * Sequence number of summary op
     */
    summarySequenceNumber?: number;
}

/**
 * An instance of RunningSummarizer manages the heuristics for summarizing.
 * Until disposed, the instance of RunningSummarizer can assume that it is
 * in a state of running, meaning it is connected and initialized.  It keeps
 * track of summaries that it is generating as they are broadcast and acked/nacked.
 */
export class RunningSummarizer implements IDisposable {
    public static async start(
        clientId: string,
        onBehalfOfClientId: string,
        logger: ITelemetryLogger,
        summaryWatcher: IClientSummaryWatcher,
        configuration: ISummaryConfiguration,
        generateSummary: (full: boolean, safe: boolean) => Promise<GenerateSummaryData | undefined>,
        lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
        immediateSummary: boolean,
    ): Promise<RunningSummarizer> {
        const summarizer = new RunningSummarizer(
            clientId,
            onBehalfOfClientId,
            logger,
            summaryWatcher,
            configuration,
            generateSummary,
            lastOpSeqNumber,
            firstAck,
            immediateSummary);

        await summarizer.waitStart();

        // Run the heuristics after starting
        if (immediateSummary) {
            summarizer.trySummarize("immediate");
        } else {
            summarizer.heuristics.run();
        }
        return summarizer;
    }

    public get disposed() { return this._disposed; }

    private _disposed = false;
    private summarizing = false;
    private summarizeCount: number = 0;
    private tryWhileSummarizing = false;
    private readonly summarizeTimer: Timer;
    private readonly pendingAckTimer: PromiseTimer;
    private readonly heuristics: SummarizerHeuristics;

    private constructor(
        private readonly clientId: string,
        private readonly onBehalfOfClientId: string,
        private readonly logger: ITelemetryLogger,
        private readonly summaryWatcher: IClientSummaryWatcher,
        private readonly configuration: ISummaryConfiguration,
        private readonly generateSummary: (full: boolean, safe: boolean) => Promise<GenerateSummaryData | undefined>,
        lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
        private immediateSummary: boolean = false,
    ) {
        this.heuristics = new SummarizerHeuristics(
            configuration,
            (reason) => this.trySummarize(reason),
            lastOpSeqNumber,
            firstAck);

        this.summarizeTimer = new Timer(
            maxSummarizeTimeoutTime,
            () => this.summarizeTimerHandler(maxSummarizeTimeoutTime, 1));

        this.pendingAckTimer = new PromiseTimer(
            this.configuration.maxAckWaitTime,
            () => {
                this.logger.sendErrorEvent({
                    eventName: "SummaryAckWaitTimeout",
                    maxAckWaitTime: this.configuration.maxAckWaitTime,
                    refSequenceNumber: this.heuristics.lastSent.refSequenceNumber,
                    summarySequenceNumber: this.heuristics.lastSent.summarySequenceNumber,
                    timePending: Date.now() - this.heuristics.lastSent.summaryTime,
                });
            });
    }

    public dispose(): void {
        this.summaryWatcher.dispose();
        this.heuristics.dispose();
        this.summarizeTimer.clear();
        this.pendingAckTimer.clear();
        this._disposed = true;
    }

    public handleSystemOp(op: ISequencedDocumentMessage) {
        switch (op.type) {
            case MessageType.ClientLeave: {
                const leavingClientId = JSON.parse((op as ISequencedDocumentSystemMessage).data) as string;
                if (leavingClientId === this.clientId || leavingClientId === this.onBehalfOfClientId) {
                    // Ignore summarizer leave messages, to make sure not to start generating
                    // a summary as the summarizer is leaving
                    return;
                }
                // Leave ops for any other client fall through to handle normally
            }
            // Intentional fallthrough
            case MessageType.ClientJoin:
            case MessageType.Propose:
            case MessageType.Reject: {
                // Synchronously handle quorum ops like regular ops
                this.handleOp(undefined, op);
                return;
            }
            default: {
                return;
            }
        }
    }

    public handleOp(error: any, op: ISequencedDocumentMessage) {
        if (error !== undefined) {
            return;
        }
        this.heuristics.lastOpSeqNumber = op.sequenceNumber;

        // Check for ops requesting summary
        if (op.type === MessageType.Save) {
            this.trySummarize(`;${op.clientId}: ${op.contents}`);
        } else {
            this.heuristics.run();
        }
    }

    private async waitStart() {
        // Wait no longer than ack timeout for all pending
        const maybeLastAck = await Promise.race([
            this.summaryWatcher.waitFlushed(),
            this.pendingAckTimer.start(),
        ]);
        this.pendingAckTimer.clear();

        if (maybeLastAck) {
            this.heuristics.lastSent = {
                refSequenceNumber: maybeLastAck.summaryOp.referenceSequenceNumber,
                summaryTime: maybeLastAck.summaryOp.timestamp,
                summarySequenceNumber: maybeLastAck.summaryOp.sequenceNumber,
            };
            this.heuristics.ackLastSent();
        }
    }

    private trySummarize(reason: string) {
        this.trySummarizeCore(reason).catch((error) => {
            this.logger.sendErrorEvent({ eventName: "UnexpectedSummarizeError" }, error);
        });
    }

    private async trySummarizeCore(reason: string) {
        if (this.summarizing) {
            // We can't summarize if we are already
            this.tryWhileSummarizing = true;
            return;
        }

        // GenerateSummary could take some time
        // mark that we are currently summarizing to prevent concurrent summarizing
        this.summarizing = true;

        try {
            const result = await this.summarize(reason, false);
            if (result === false) {
                // On nack, try again in safe mode
                await this.summarize(reason, true);
            }
        } finally {
            this.summarizing = false;
            if (this.tryWhileSummarizing) {
                this.tryWhileSummarizing = false;
                this.heuristics.run();
            }
        }
    }

    /**
     * Generates summary and listens for broadcast and ack/nack.
     * Returns true for ack, false for nack, and undefined for failure or timeout.
     * @param reason - reason for summarizing
     * @param safe - true to generate summary in safe mode
     */
    private async summarize(reason: string, safe: boolean): Promise<boolean | undefined> {
        this.summarizeTimer.start();

        try {
            return this.summarizeCore(reason, safe);
        } finally {
            this.summarizeTimer.clear();
            this.pendingAckTimer.clear();
        }
    }

    private async summarizeCore(reason: string, safe: boolean): Promise<boolean | undefined> {
        // Wait to generate and send summary
        const summaryData = await this.generateSummaryWithLogging(reason, safe);
        if (!summaryData || !summaryData.submitted) {
            // Did not send the summary op
            return undefined;
        }

        this.heuristics.lastSent = {
            refSequenceNumber: summaryData.referenceSequenceNumber,
            summaryTime: Date.now(),
        };

        const pendingTimeoutP = this.pendingAckTimer.start();
        const summary = this.summaryWatcher.watchSummary(summaryData.clientSequenceNumber);

        // Wait for broadcast
        const summaryOp = await Promise.race([summary.waitBroadcast(), pendingTimeoutP]);
        if (!summaryOp) {
            return undefined;
        }
        this.heuristics.lastSent.summarySequenceNumber = summaryOp.sequenceNumber;
        this.logger.sendTelemetryEvent({
            eventName: "SummaryOp",
            timeWaiting: Date.now() - this.heuristics.lastSent.summaryTime,
            refSequenceNumber: summaryOp.referenceSequenceNumber,
            summarySequenceNumber: summaryOp.sequenceNumber,
            handle: summaryOp.contents.handle,
        });

        // Wait for ack/nack
        const ackNack = await Promise.race([summary.waitAckNack(), pendingTimeoutP]);
        if (!ackNack) {
            return undefined;
        }
        this.logger.sendTelemetryEvent({
            eventName: ackNack.type === MessageType.SummaryAck ? "SummaryAck" : "SummaryNack",
            category: ackNack.type === MessageType.SummaryAck ? "generic" : "error",
            timeWaiting: Date.now() - this.heuristics.lastSent.summaryTime,
            summarySequenceNumber: ackNack.contents.summaryProposal.summarySequenceNumber,
            error: ackNack.type === MessageType.SummaryNack ? ackNack.contents.errorMessage : undefined,
            handle: ackNack.type === MessageType.SummaryAck ? ackNack.contents.handle : undefined,
        });

        this.pendingAckTimer.clear();

        // Update for success
        if (ackNack.type === MessageType.SummaryAck) {
            this.heuristics.ackLastSent();

            // since we need a full summary after context reload, we only clear this on ack
            this.immediateSummary = false;

            return true;
        } else {
            return false;
        }
    }

    private async generateSummaryWithLogging(message: string, safe: boolean): Promise<GenerateSummaryData | undefined> {
        const summarizingEvent = PerformanceEvent.start(this.logger, {
            eventName: "Summarizing",
            message,
            summarizeCount: ++this.summarizeCount,
            timeSinceLastAttempt: Date.now() - this.heuristics.lastSent.summaryTime,
            timeSinceLastSummary: Date.now() - this.heuristics.lastAcked.summaryTime,
        });

        // Wait for generate/send summary
        let summaryData: GenerateSummaryData | undefined;
        try {
            summaryData = await this.generateSummary(this.immediateSummary, safe);
        } catch (error) {
            summarizingEvent.cancel({ category: "error" }, error);
            return;
        }

        this.summarizeTimer.clear();

        if (!summaryData) {
            summarizingEvent.cancel();
            return;
        }

        const telemetryProps: any = {
            ...summaryData,
            ...summaryData.summaryStats,
            refSequenceNumber: summaryData.referenceSequenceNumber,
            opsSinceLastAttempt: summaryData.referenceSequenceNumber - this.heuristics.lastSent.refSequenceNumber,
            opsSinceLastSummary: summaryData.referenceSequenceNumber - this.heuristics.lastAcked.refSequenceNumber,
        };
        telemetryProps.summaryStats = undefined;
        telemetryProps.referenceSequenceNumber = undefined;

        if (summaryData.submitted) {
            summarizingEvent.end(telemetryProps);
        } else {
            summarizingEvent.cancel(telemetryProps);
        }

        return summaryData;
    }

    private summarizeTimerHandler(time: number, count: number) {
        this.logger.sendErrorEvent({
            eventName: "SummarizeTimeout",
            timeoutTime: time,
            timeoutCount: count,
        });
        if (count < maxSummarizeTimeoutCount) {
            // Double and start a new timer
            const nextTime = time * 2;
            this.summarizeTimer.start(nextTime, () => this.summarizeTimerHandler(nextTime, count + 1));
        }
    }
}

/**
 * This class contains the heuristics for when to summarize.
 */
class SummarizerHeuristics {
    /**
     * Last sent summary attempt
     */
    public lastSent: ISummaryAttempt;
    private _lastAcked: ISummaryAttempt;

    /**
     * Last acked summary attempt
     */
    public get lastAcked(): ISummaryAttempt {
        return this._lastAcked;
    }

    private readonly idleTimer: Timer;

    public constructor(
        private readonly configuration: ISummaryConfiguration,
        private readonly trySummarize: (reason: string) => void,
        /**
         * Last received op sequence number
         */
        public lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
    ) {
        this.lastSent = firstAck;
        this._lastAcked = firstAck;
        this.idleTimer = new Timer(
            this.configuration.idleTime,
            () => this.trySummarize("idle"));
    }

    /**
     * Mark the last sent summary attempt as acked.
     */
    public ackLastSent() {
        this._lastAcked = this.lastSent;
    }

    /**
     * Runs the heuristic to determine if it should try to summarize.
     */
    public run() {
        this.idleTimer.clear();
        const timeSinceLastSummary = Date.now() - this.lastAcked.summaryTime;
        const opCountSinceLastSummary = this.lastOpSeqNumber - this.lastAcked.refSequenceNumber;

        if (timeSinceLastSummary > this.configuration.maxTime) {
            this.trySummarize("maxTime");
        } else if (opCountSinceLastSummary > this.configuration.maxOps) {
            this.trySummarize("maxOps");
        } else {
            this.idleTimer.start();
        }
    }

    /**
     * Disposes of resources.
     */
    public dispose() {
        this.idleTimer.clear();
    }
}
