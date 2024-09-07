import * as zmq from "zeromq"

export enum MessageType {
    Handshake,
    Preflight,
    Progress,
    ErrorFatal,
    ErrorNonfatal,
    FinishSuccess
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

interface MessageData {
    total?: number
    status?: Status
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
            case MessageType.Handshake | MessageType.FinishSuccess:
                this.send(JSON.stringify({"tag": this.tag, "type": type}))
                break;

            case MessageType.Preflight:
                this.send(JSON.stringify({"tag": this.tag, "type": type, "total": data?.total}))
                break;
            
            case MessageType.Progress:
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