import * as zmq from "zeromq"

export enum MessageType {
    Handshake,
    Preflight,
    Progress,
    Error,
    FinishSuccess
}

export class ZmqSender {
    private socket: zmq.Push
    private tag: string

    private log(message: string) {
        console.log(`[zmq-${this.tag}]: ${message}`);
    }

    private send(message: zmq.MessageLike) {
        if(this.socket.writable) {
            this.socket.send(message)
        } else {
            this.log("ERROR: Socket busy")
        }
    }

    public sendMessage(type: MessageType, data: Object) {
        switch (type) {
            case MessageType.Handshake:
                this.send(JSON.stringify({"tag": this.tag, "type": type}))
                break;
        
            default:
                this.log("ERROR: Undefined message type")
                break;
        }
    }

    constructor(tag: string, address: string) {
        this.socket = new zmq.Push()
        this.tag = tag
        this.socket.connect(address)
        this.log(`Connected to ${address}`)
    }
}