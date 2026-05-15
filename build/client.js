import WebSocket from 'ws';
import crypto from 'crypto';
import { EventEmitter } from 'events';
const logger = {
    log: (message) => console.error(message),
    error: (message) => console.error(message),
    debug: (message) => console.error(message),
};
// Define OpCodes
var OpCode;
(function (OpCode) {
    OpCode[OpCode["Hello"] = 0] = "Hello";
    OpCode[OpCode["Identify"] = 1] = "Identify";
    OpCode[OpCode["Identified"] = 2] = "Identified";
    OpCode[OpCode["Reidentify"] = 3] = "Reidentify";
    OpCode[OpCode["Event"] = 5] = "Event";
    OpCode[OpCode["Request"] = 6] = "Request";
    OpCode[OpCode["RequestResponse"] = 7] = "RequestResponse";
    OpCode[OpCode["RequestBatch"] = 8] = "RequestBatch";
    OpCode[OpCode["RequestBatchResponse"] = 9] = "RequestBatchResponse";
})(OpCode || (OpCode = {}));
// Define EventSubscription bitmasks
export var EventSubscription;
(function (EventSubscription) {
    EventSubscription[EventSubscription["None"] = 0] = "None";
    EventSubscription[EventSubscription["General"] = 1] = "General";
    EventSubscription[EventSubscription["Config"] = 2] = "Config";
    EventSubscription[EventSubscription["Scenes"] = 4] = "Scenes";
    EventSubscription[EventSubscription["Inputs"] = 8] = "Inputs";
    EventSubscription[EventSubscription["Transitions"] = 16] = "Transitions";
    EventSubscription[EventSubscription["Filters"] = 32] = "Filters";
    EventSubscription[EventSubscription["Outputs"] = 64] = "Outputs";
    EventSubscription[EventSubscription["SceneItems"] = 128] = "SceneItems";
    EventSubscription[EventSubscription["MediaInputs"] = 256] = "MediaInputs";
    EventSubscription[EventSubscription["Vendors"] = 512] = "Vendors";
    EventSubscription[EventSubscription["Ui"] = 1024] = "Ui";
    EventSubscription[EventSubscription["All"] = 2047] = "All";
})(EventSubscription || (EventSubscription = {}));
// Define the OBS WebSocket client class
export class OBSWebSocketClient extends EventEmitter {
    ws = null;
    url;
    password;
    connected = false;
    identified = false;
    pendingRequests = new Map();
    constructor(url = 'ws://localhost:4455', password = null) {
        super();
        this.url = url;
        this.password = password;
    }
    /**
     * Connect to the OBS WebSocket server
     */
    async connect() {
        if (this.connected) {
            return;
        }
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url);
                this.ws.on('open', () => {
                    this.connected = true;
                    logger.log('Connected to OBS WebSocket server');
                });
                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message);
                    }
                    catch (error) {
                        logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
                    }
                });
                this.ws.on('close', () => {
                    this.connected = false;
                    this.identified = false;
                    logger.log('Disconnected from OBS WebSocket server');
                    this.emit('disconnected');
                    // Clear all pending requests
                    this.pendingRequests.forEach((request) => {
                        clearTimeout(request.timeout);
                        request.reject(new Error('WebSocket connection closed'));
                    });
                    this.pendingRequests.clear();
                });
                this.ws.on('error', (error) => {
                    logger.error(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
                    reject(error);
                });
                // Set up the identification process
                this.once('hello', async (hello) => {
                    try {
                        await this.identify(hello);
                        resolve();
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Check if the client is fully connected and identified with OBS.
     * Use this for non-throwing state checks (e.g. obs-health-check).
     */
    isConnected() {
        return this.connected && this.identified;
    }
    /**
     * Ensure the client is connected. If not, attempts to connect on demand
     * and throws a clear, actionable error if connection fails.
     *
     * This is the entry point that makes the MCP "lazy connect": every tool
     * call goes through sendRequest() which calls ensureConnected() first.
     * If OBS is not running, the user gets a helpful error message instead
     * of a process crash.
     */
    async ensureConnected() {
        if (this.connected && this.identified) {
            return;
        }
        try {
            await this.connect();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot connect to OBS WebSocket at ${this.url}. ` +
                `Make sure OBS Studio is running with the WebSocket server enabled ` +
                `(Tools > WebSocket Server Settings). ` +
                `Tip: call the "obs-launch" tool to start OBS automatically. ` +
                `Underlying error: ${detail}`);
        }
    }
    /**
     * Disconnect from the OBS WebSocket server
     */
    disconnect() {
        if (this.ws && this.connected) {
            this.ws.close();
            this.ws = null;
            this.connected = false;
            this.identified = false;
        }
    }
    /**
     * Send a request to the OBS WebSocket server
     */
    async sendRequest(requestType, requestData, timeout = 10000) {
        // Lazy connect: if not connected yet, try to connect now.
        // If OBS is not running this will throw a clear error, captured by the tool's try/catch.
        await this.ensureConnected();
        if (!this.ws || !this.connected || !this.identified) {
            throw new Error('Not connected or identified with OBS WebSocket server');
        }
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request ${requestType} timed out after ${timeout}ms`));
            }, timeout);
            this.pendingRequests.set(requestId, {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    resolve(data);
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                },
                timeout: timeoutId
            });
            const requestMessage = {
                op: OpCode.Request,
                d: {
                    requestType,
                    requestId,
                    requestData
                }
            };
            this.ws.send(JSON.stringify(requestMessage));
        });
    }
    /**
     * Handle incoming messages from the OBS WebSocket server
     */
    handleMessage(message) {
        switch (message.op) {
            case OpCode.Hello:
                this.emit('hello', message.d);
                break;
            case OpCode.Identified:
                this.identified = true;
                this.emit('identified', message.d);
                break;
            case OpCode.RequestResponse:
                this.handleRequestResponse(message);
                break;
            case OpCode.Event:
                this.handleEvent(message);
                break;
            default:
                logger.debug(`Unhandled message type: ${message.op}`);
                break;
        }
    }
    /**
     * Handle request responses from the OBS WebSocket server
     */
    handleRequestResponse(message) {
        const { requestId, requestStatus, responseData } = message.d;
        const pendingRequest = this.pendingRequests.get(requestId);
        if (pendingRequest) {
            this.pendingRequests.delete(requestId);
            if (requestStatus.result) {
                pendingRequest.resolve(responseData || {});
            }
            else {
                const errorMessage = `Request failed: ${requestStatus.code} ${requestStatus.comment || ''}`;
                pendingRequest.reject(new Error(errorMessage));
            }
        }
    }
    /**
     * Handle events from the OBS WebSocket server
     */
    handleEvent(message) {
        const { eventType, eventData } = message.d;
        this.emit('event', eventType, eventData);
        this.emit(eventType, eventData);
    }
    /**
     * Identify with the OBS WebSocket server
     */
    async identify(hello) {
        if (!this.ws || !this.connected) {
            throw new Error('Not connected to OBS WebSocket server');
        }
        let authentication;
        // Handle authentication if required
        if (hello.authentication && this.password) {
            authentication = this.generateAuthenticationString(this.password, hello.authentication.salt, hello.authentication.challenge);
        }
        else if (hello.authentication && !this.password) {
            throw new Error('Password required for authentication but not provided');
        }
        const identifyMessage = {
            op: OpCode.Identify,
            d: {
                rpcVersion: hello.rpcVersion,
                eventSubscriptions: EventSubscription.All,
            }
        };
        if (authentication) {
            identifyMessage.d.authentication = authentication;
        }
        return new Promise((resolve, reject) => {
            // Set up a one-time listener for the Identified message
            this.once('identified', () => {
                logger.log('Identified with OBS WebSocket server');
                resolve();
            });
            // Set a timeout for identification
            const timeoutId = setTimeout(() => {
                reject(new Error('Identification timed out'));
            }, 5000);
            this.once('identified', () => clearTimeout(timeoutId));
            // Send the Identify message
            this.ws.send(JSON.stringify(identifyMessage));
        });
    }
    /**
     * Generate authentication string for OBS WebSocket
     */
    generateAuthenticationString(password, salt, challenge) {
        // Create SHA256 Base64 encoded secret
        const secretBytes = crypto.createHash('sha256')
            .update(password + salt)
            .digest();
        const secret = secretBytes.toString('base64');
        // Create authentication string
        const authBytes = crypto.createHash('sha256')
            .update(secret + challenge)
            .digest();
        const authentication = authBytes.toString('base64');
        return authentication;
    }
}
export default OBSWebSocketClient;
