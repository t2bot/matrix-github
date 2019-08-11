import { Appservice, IAppserviceRegistration, SimpleFsStorageProvider } from "matrix-bot-sdk";
import Octokit, { IssuesGetResponseUser } from "@octokit/rest";
import { IBridgeRoomState, BRIDGE_STATE_TYPE } from "./BridgeState";
import { BridgeConfig } from "./Config";
import { IWebhookEvent, IOAuthRequest, IOAuthTokens } from "./GithubWebhooks";
import { CommentProcessor } from "./CommentProcessor";
import { MessageQueue, createMessageQueue } from "./MessageQueue/MessageQueue";
import { AdminRoom } from "./Rooms/AdminRoom";
import { UserTokenStore } from "./UserTokenStore";
import { FormatUtil } from "./FormatUtil";
import { MatrixEvent, MatrixMemberContent, MatrixMessageContent, MatrixEventContent } from "./MatrixEvent";
import { LogWrapper } from "./LogWrapper";
import { IMatrixSendMessage, IMatrixSendMessageResponse } from "./MatrixSender";
import { RoomStore } from "./Rooms/RoomStore";
import { IssueRoom } from "./Rooms/IssueRoom";

const log = new LogWrapper("GithubBridge");

export class GithubBridge {
    private octokit!: Octokit;
    private as!: Appservice;
    private roomStore!: RoomStore;
    private commentProcessor!: CommentProcessor;
    private queue!: MessageQueue;
    private tokenStore!: UserTokenStore;

    private matrixHandledEvents: Set<string>;

    constructor(private config: BridgeConfig, private registration: IAppserviceRegistration) {
        this.matrixHandledEvents = new Set();
    }

    public async start() {
        this.queue = createMessageQueue(this.config);

        log.debug(this.queue);

        this.octokit = new Octokit({
            auth: this.config.github.auth,
            userAgent: "matrix-github v0.0.1",
        });

        const storage = new SimpleFsStorageProvider(this.config.bridge.store || "bridgestore.json");

        this.as = new Appservice({
            homeserverName: this.config.bridge.domain,
            homeserverUrl: this.config.bridge.url,
            port: this.config.bridge.port,
            bindAddress: this.config.bridge.bindAddress,
            registration: this.registration,
            storage,
        });

        this.roomStore = new RoomStore(this.as.botIntent, this.tokenStore, this.config);
        const initStorePromise = this.roomStore.initStore();


        this.commentProcessor = new CommentProcessor(this.as, this.config.bridge.mediaUrl);

        this.tokenStore = new UserTokenStore(this.config.github.passFile || "./passkey.pem", this.as.botIntent);
        await this.tokenStore.load();

        this.as.on("query.room", (roomAlias, cb) => {
            cb(this.onQueryRoom(roomAlias));
        });

        this.as.on("room.event", async (roomId, event) => {
            return this.onRoomEvent(roomId, event);
        });

        this.queue.subscribe("comment.*");
        this.queue.subscribe("issue.*");
        this.queue.subscribe("response.matrix.message");

        this.queue.on<IWebhookEvent>("comment.created", async (msg) => {
            return this.onCommentCreated(msg.data);
        });

        this.queue.on<IWebhookEvent>("issue.edited", async (msg) => {
            return this.onIssueEdited(msg.data);
        });

        this.queue.on<IWebhookEvent>("issue.closed", async (msg) => {
            return this.onIssueStateChange(msg.data);
        });

        this.queue.on<IWebhookEvent>("issue.reopened", async (msg) => {
            return this.onIssueStateChange(msg.data);
        });

        this.queue.on<IOAuthRequest>("oauth.response", async (msg) => {
            const adminRoom = this.roomStore.getWithOauthState(msg.data.state);
            this.queue.push<boolean>({
                data: !!(adminRoom),
                sender: "GithubBridge",
                messageId: msg.messageId,
                eventName: "response.oauth.response",
            });
        });

        this.queue.on<IOAuthTokens>("oauth.tokens", async (msg) => {
            const adminRoom = this.roomStore.getWithOauthState(msg.data.state);
            if (!adminRoom) {
                log.warn("Could not find admin room for successful tokens request. This shouldn't happen!");
                return;
            }
            adminRoom.clearOauthState();
            await this.tokenStore.storeUserToken(adminRoom.userId, msg.data.access_token);
        });

        await initStorePromise;
        await this.as.begin();
        log.info("Started bridge");
    }

    private async onRoomEvent(roomId: string, event: MatrixEvent<unknown>) {
        const room = await this.roomStore.getRoom(roomId);
        const isOurUser = this.as.isNamespacedUser(event.sender);

        if (room) {
            log.debug(`Found ${room.constructor.name} for ${roomId}`);
            if ( await room.onEvent(event, isOurUser)) {
                return;
            }
        } else if (event.type === "m.room.member" && !isOurUser) {
            const memberEvent = event as MatrixEvent<MatrixMemberContent>;
            if (memberEvent.content.membership !== "invite") {
                return;
            }
            const adminRoom = await AdminRoom.tryCreateNew(memberEvent, this.as.botIntent, this.tokenStore, this.config);
            if (adminRoom === undefined) {
                log.warn(`Could not create admin room for ${roomId} (${event.sender})`);
                return;
            }
            await adminRoom.storeRoom();
        }

        if (!(room instanceof IssueRoom)) {
            return; // The next bit of code only applies to issue rooms.
        }

        // Get a client for the IRC user.
        const githubRepo = room.state;
        log.info(`Got new request for ${githubRepo.org}${githubRepo.repo}#${room.issue}`);
        if (!isOurUser && event.type === "m.room.message") {
            const messageEvent = event as MatrixEvent<MatrixMessageContent>;
            if (messageEvent.content.body === "!sync") {
                await room.syncIssueState(this.octokit, this.as);
            }
            await this.onMatrixIssueComment(messageEvent, room);
        }
        log.debug(event);
    }

    private async getIntentForUser(user: IssuesGetResponseUser) {
        const intent = this.as.getIntentForSuffix(user.login);
        const displayName = `${user.login}`;
        // Verify up-to-date profile
        let profile;
        await intent.ensureRegistered();
        try {
            profile = await intent.underlyingClient.getUserProfile(intent.userId);
            if (profile.displayname !== displayName || (!profile.avatar_url && user.avatar_url)) {
                log.info(`${intent.userId}'s profile is out of date`);
                // Also set avatar
                const buffer = await this.octokit.request(user.avatar_url);
                log.info(`uploading ${user.avatar_url}`);
                // This does exist, but headers is silly and doesn't have content-type.
                // tslint:disable-next-line: no-any
                const contentType = (buffer.headers as any)["content-type"];
                const mxc = await intent.underlyingClient.uploadContent(
                    Buffer.from(buffer.data as ArrayBuffer),
                    contentType,
                );
                await intent.underlyingClient.setAvatarUrl(mxc);
                await intent.underlyingClient.setDisplayName(displayName);
            }
        } catch (ex) {
            profile = {};
        }

        return intent;
    }

    private async onQueryRoom(roomAlias: string) {
        log.info("Got room query request:", roomAlias);
        const match = /#github_(.+)_(.+)_(\d+):.*/.exec(roomAlias);
        if (!match || match.length < 4) {
            throw Error("Alias is in an incorrect format");
        }
        const parts = match!.slice(1);
        const issueNumber = parseInt(parts[2], 10);

        const issue = await this.octokit.issues.get({
            owner: parts[0],
            repo: parts[1],
            issue_number: issueNumber,
        });

        if (issue.status !== 200) {
            throw Error("Could not find issue");
        }

        const orgRepoName = issue.data.repository_url.substr("https://api.github.com/repos/".length);

        return {
            visibility: "public",
            name: FormatUtil.formatName(issue.data),
            topic: FormatUtil.formatTopic(issue.data),
            preset: "public_chat",
            initial_state: [
                {
                    type: BRIDGE_STATE_TYPE,
                    content: {
                        org: orgRepoName.split("/")[0],
                        repo: orgRepoName.split("/")[1],
                        issues: [String(issue.data.number)],
                        comments_processed: -1,
                        state: "open",
                    },
                    state_key: issue.data.url,
                } as IBridgeRoomState,
            ],
        };
    }

    private async onCommentCreated(event: IWebhookEvent, room?: IssueRoom, updateState: boolean = true) {
        if (!room) {
            const room = this.roomStore.findRoomForIssue(
                event.repository!.owner.login,
                event.repository!.name,
                event.issue!.number,
            )
            if (!room) {
                log.debug("No rooms are bridged to this comment");
                return;
            }
        }
        const comment = event.comment!;
        if (event.repository) {
            // Delay to stop comments racing sends
            await new Promise((resolve) => setTimeout(resolve, 500));
            const dupeKey =
            `${event.repository.owner.login}/${event.repository.name}#${event.issue!.number}~${comment.id}`
            .toLowerCase();
            if (this.matrixHandledEvents.has(dupeKey)) {
                return;
            }
        }
        const commentIntent = await this.getIntentForUser(comment.user);
        const matrixEvent = await this.commentProcessor.getEventBodyForComment(comment);

        await this.sendMatrixMessage(room!.roomId, matrixEvent, "m.room.message", commentIntent.userId);
        // if (!updateState) {
        //     return;
        // }
        // const state = (await this.getRoomBridgeState(roomId))[0];
        // state.content.comments_processed++;
        // await this.as.botIntent.underlyingClient.sendStateEvent(
        //     room!.roomId,
        //     BRIDGE_STATE_TYPE,
        //     state.state_key,
        //     state.content,
        // );
    }

    private async onIssueEdited(event: IWebhookEvent) {
        if (!event.changes) {
            log.debug("No changes given");
            return;
        }

        const room = this.roomStore.findRoomForIssue(
            event.repository!.owner.login,
            event.repository!.name,
            event.issue!.number,
        )

        if (!room) {
            log.debug("No tracked room state");
            return;
        }

        if (event.changes.title) {
            await this.as.botIntent.underlyingClient.sendStateEvent(room.roomId, "m.room.name", "", {
                name: FormatUtil.formatName(event.issue!),
            });
        }
    }

    private async onIssueStateChange(event: IWebhookEvent) {
        const room = this.roomStore.findRoomForIssue(
            event.repository!.owner.login,
            event.repository!.name,
            event.issue!.number,
        )

        if (!room) {
            log.debug("No tracked room state");
            return;
        }

        await room.syncIssueState(this.octokit, this.as);
    }

    private async onMatrixIssueComment(event: MatrixEvent<MatrixMessageContent>, room: IssueRoom) {
        const senderToken = await this.tokenStore.getUserToken(event.sender);
        let body = await this.commentProcessor.getCommentBodyForEvent(event.content);
        let octokit: Octokit;
        if (senderToken !== null) {
            octokit = new Octokit({
                auth: senderToken,
                userAgent: "matrix-github v0.0.1",
            });
        } else {
            octokit = this.octokit;
            body = `\`${event.sender}\`: ${body}`;
        }

        const result = await octokit.issues.createComment({
            repo: room.state.repo,
            owner: room.state.org,
            body,
            issue_number: room.issue,
        });
        const key =
        `${room.state.org}/${room.state.repo}#${room.issue}~${result.data.id}`
        .toLowerCase();
        this.matrixHandledEvents.add(key);
    }

    private async sendMatrixMessage(roomId: string,
                                    content: MatrixEventContent, eventType: string = "m.room.message",
                                    sender: string|null = null): Promise<string> {
        return (await this.queue.pushWait<IMatrixSendMessage, IMatrixSendMessageResponse>({
            eventName: "matrix.message",
            sender: "GithubBridge",
            data: {
                roomId,
                type: eventType,
                sender,
                content,
            },
        })).eventId;
    }
}
