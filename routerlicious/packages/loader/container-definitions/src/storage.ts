import * as resources from "@prague/gitresources";
import { EventEmitter } from "events";
import { IClient } from "./clients";
import {
    IContentMessage,
    IDocumentMessage,
    ISequencedDocumentMessage,
} from "./protocol";
import { ITokenProvider } from "./tokens";

export interface IDocumentAttributes {
    /**
     * Name of the branch that created the snapshot
     */
    branch: string;

    /**
     * Sequence number at which the snapshot was taken
     */
    sequenceNumber: number;

    /**
     * Minimum sequence number when the snapshot was taken
     */
    minimumSequenceNumber: number;

    /**
     * List of clients when the snapshot was taken
     */
    partialOps: Array<[string, string[]]>;
}

export enum FileMode {
    File = "100644",
    Executable = "100755",
    Directory = "040000",
    Commit = "160000",
    Symlink = "120000",
}

/**
 * Raw blob stored within the tree
 */
export interface IBlob {
    // Contents of the blob
    contents: string;

    // The encoding of the contents string (utf-8 or base64)
    encoding: string;
}

/**
 * A tree entry wraps a path with a type of node
 */
export interface ITreeEntry {
    // Path to the object
    path: string;

    // One of the above enum string values
    type: string;

    // The value of the entry - either a tree or a blob
    value: IBlob | ITree | string;

    // The file mode; one of 100644 for file (blob), 100755 for executable (blob), 040000 for subdirectory (tree),
    // 160000 for submodule (commit), or 120000 for a blob that specifies the path of a symlink
    mode: FileMode;
}

/**
 * Type of entries that can be stored in a tree
 */
export enum TreeEntry {
    Blob,
    Commit,
    Tree,
}

export interface ITree {
    entries: ITreeEntry[];
}

export interface ISnapshotTree {
    sha: string;
    blobs: { [path: string]: string };
    commits: { [path: string]: string };
    trees: { [path: string]: ISnapshotTree };
}

/**
 * Interface to provide access to stored deltas for a shared object
 */
export interface IDeltaStorageService {
    /**
     * Retrieves all the delta operations within the inclusive sequence number range
     */
    get(
        tenantId: string,
        id: string,
        tokenProvider: ITokenProvider,
        from?: number,
        to?: number): Promise<ISequencedDocumentMessage[]>;
}

/**
 * Interface to provide access to stored deltas for a shared object
 */
export interface IDocumentDeltaStorageService {
    /**
     * Retrieves all the delta operations within the exclusive sequence number range
     */
    get(from?: number, to?: number): Promise<ISequencedDocumentMessage[]>;
}

/**
 * Interface to provide access to snapshots saved for a shared object
 */
export interface IDocumentStorageService {
    repositoryUrl: string;

    /**
     * Returns the snapshot tree.
     */
    getSnapshotTree(version?: resources.ICommit): Promise<ISnapshotTree>;

    /**
     * Retrieves all versions of the document starting at the specified sha - or null if from the head
     */
    getVersions(sha: string, count: number): Promise<resources.ICommit[]>;

    /**
     * Retrieves the content for the given commit at the given path
     */
    getContent(version: resources.ICommit, path: string): Promise<string>;

    /**
     * Reads the object with the given ID
     */
    read(sha: string): Promise<string>;

    /**
     * Writes to the object with the given ID
     */
    write(root: ITree, parents: string[], message: string, ref: string): Promise<resources.ICommit>;

    /**
     * Creates a blob out of the given buffer
     */
    createBlob(file: Buffer): Promise<resources.ICreateBlobResponse>;

    /**
     * Fetch image Data url
     */
    getRawUrl(sha: string): string;
}

// Error tracking service.
export interface IErrorTrackingService {
    /**
     * Track error/exception using a service.
     */
    track(func: () => void);
}

export interface IDocumentDeltaConnection extends EventEmitter {
    /**
     * ClientID for the connection
     */
    clientId: string;

    /**
     * DocumentId for the connection
     */
    documentId: string;

    /**
     * Whether the connection was made to a new or existing document
     */
    existing: boolean;

    /**
     * The parent branch for the document
     */
    parentBranch: string;

    /**
     * Maximum size of a message that can be sent to the server. Messages larger than this size must be chunked.
     */
    maxMessageSize: number;

    /**
     * Messages sent during the connection
     */
    initialMessages?: ISequencedDocumentMessage[];

    /**
     * Messages sent during the connection
     */
    initialContents?: IContentMessage[];

    /**
     * Submit a new message to the server
     */
    submit(message: IDocumentMessage): void;

    /**
     * Async version of the regular submit function.
     */
    // TODO why the need for two of these?
    submitAsync(message: IDocumentMessage): Promise<void>;

    /**
     * Disconnects the given delta connection
     */
    disconnect();
}

export interface IDocumentService {
    /**
     * Access to storage associated with the document...
     */
    connectToStorage(tenantId: string, id: string, tokenProvider: ITokenProvider): Promise<IDocumentStorageService>;

    /**
     * Access to delta storage associated with the document
     */
    connectToDeltaStorage(
        tenantId: string,
        id: string,
        tokenProvider: ITokenProvider): Promise<IDocumentDeltaStorageService>;

    /**
     * Subscribes to the document delta stream
     */
    connectToDeltaStream(
        tenantId: string,
        id: string,
        tokenProvider: ITokenProvider,
        client: IClient): Promise<IDocumentDeltaConnection>;

    /**
     * Creates a branch of the document with the given ID. Returns the new ID.
     */
    branch(tenantId: string, id: string, tokenProvider: ITokenProvider): Promise<string>;

    /**
     * Returns the error tracking service
     */
    getErrorTrackingService(): IErrorTrackingService;
}
