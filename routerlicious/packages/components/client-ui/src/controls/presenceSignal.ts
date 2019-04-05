import { IInboundSignalMessage, IRuntime } from "@prague/runtime-definitions";
import { EventEmitter } from "events";

const presenceKey = "presence";

export class PresenceSignal extends EventEmitter {
    constructor(private runtime: IRuntime) {
        super();
        this.listenForPresence();
    }

    public submitPresence(content: any) {
        this.runtime.submitSignal(presenceKey, content);
    }

    private listenForPresence() {
        this.runtime.on("signal", (message: IInboundSignalMessage, local: boolean) => {
            if (message.type === presenceKey) {
                this.emit("message", message, local);
            }
        });
    }
}
