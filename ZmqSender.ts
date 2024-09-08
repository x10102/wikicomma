import * as zmq from "zeromq"

export enum MessageType {
    Handshake,
    Preflight,
    Progress,
    ErrorFatal,
    ErrorNonfatal,
    FinishSuccess,
    PageDone,
    PagePostponed
}

export enum Status {
    BuildingSitemap,
    PagesMain,
    ForumsMain,
    PagesPending,
    FilesPending,
    Compressing,
    FatalError,
    Other
}

export enum ErrorKind {
    ErrorClientOffline,
    ErrorMalformedSitemap,
    ErrorVoteFetch,
    ErrorFileFetch,
    ErrorLockStatusFetch,
    ErrorForumListFetch,
    ErrorForumPostFetch,
    ErrorFileMetaFetch,
    ErrorFileUnlink,
    ErrorForumCountMismatch,
    ErrorWikidotInternal,
    ErrorWhatTheFuck,
    ErrorMetaMissing,
    ErrorGivingUp,
    ErrorTokenInvalidated
}


export interface MessageData {
    total?: number
    status?: Status
    name?: string
    errorKind?: ErrorKind
    errorStr?: string
}

export class ZmqSender {
    private socket: zmq.Push

    private log(message: string) {
        console.log(`[zmq-${this.tag}]: ${message}`);
    }

    private send(message: zmq.MessageLike) {
        // TODO: Better error handling
        if(this.socket.writable) {
            this.socket.send(message)
        } else {
            this.log("ERROR: Socket busy")
        }
    }

    public sendMessage(type: MessageType, data?: MessageData) {
        switch (type) {
            case MessageType.Handshake:
            case MessageType.FinishSuccess:
            case MessageType.PageDone:
            case MessageType.PagePostponed:
                this.send(JSON.stringify({"tag": this.tag, "type": type}))
                break;

            case MessageType.Preflight:
                this.send(JSON.stringify({"tag": this.tag, "type": type, "total": data?.total}))
                break;
            
            case MessageType.Progress:
            case MessageType.ErrorFatal:
            case MessageType.ErrorNonfatal:
                this.send(JSON.stringify({"tag": this.tag, "type": type, ...data}))
                break;

            default:
                this.log("ERROR: Undefined message type")
                break;
        }
    }

    constructor(private tag: string, private address: string) {
        this.socket = new zmq.Push()
    }

    public init() {
        this.socket.connect(this.address)
        this.log(`Connected to ${this.address}`)
        this.log("Sending handshake message")
        this.sendMessage(MessageType.Handshake)
    }
}