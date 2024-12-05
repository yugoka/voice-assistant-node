import WebSocket from "ws";
import dotenv from "dotenv";
import mic from "mic";
import Speaker from "speaker";
import { PassThrough } from "stream";
import axios from "axios"; // axiosをインポート
import { FunctionDef, ToolSearchApiResponse, BaseTool } from "tool"; // 型定義をインポート
import { updateToolListFunction } from "./tools";
import { Thread } from "thread";

// Node.jsの組み込みfetchを使用するためにNode.js v18以上が必要です
dotenv.config();

class RealtimeChat {
  private OPENAI_API_KEY: string;
  private MODEL_NAME: string;
  private threadId: string;

  // 状態変数
  private conversationHistory: any[];
  private inactivityTimer: NodeJS.Timeout | null;
  private isPlayingAudio: boolean;
  private isAssistantResponding: boolean;
  private isUserSpeaking: boolean;
  private lastAssistantItemId: string | null;
  private assistantAudioContentIndex: number | null;
  private assistantAudioDurationMs: number;
  private assistantAudioPlaybackDurationMs: number;
  private eventCounter: number;
  private conversationItems: Map<string, any>;
  private truncatedAssistantItemIds: Set<string>;
  private functionCalls: Map<string, any>;
  private audioDone: boolean;
  private responseInProgress: boolean;
  private responseQueue: any[];

  // オーディオ関連
  private micInstance: any;
  private speakerInstance: Speaker | null;
  private audioStream: PassThrough | null;
  private audioStop: boolean;

  // WebSocket
  private ws: WebSocket;
  private url: string;
  private wsHeaders: any;

  // 新しく追加した変数
  private dynamicTools: Map<string, ToolSearchApiResponse>;
  private pendingFunctionCalls: Map<string, Function>;

  // 新しく追加した変数: 最後にログを出力したメッセージのインデックス
  private lastLoggedIndex: number;

  constructor(options?: { threadId?: string }) {
    // 設定
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    this.MODEL_NAME = "gpt-4o-realtime-preview";
    this.threadId = options?.threadId || process.env.ASSISTANT_HUB_THREAD_ID!;

    // 状態変数の初期化
    this.conversationHistory = [];
    this.inactivityTimer = null;
    this.isPlayingAudio = false;
    this.isAssistantResponding = false;
    this.isUserSpeaking = false;
    this.lastAssistantItemId = null;
    this.assistantAudioContentIndex = null;
    this.assistantAudioDurationMs = 0;
    this.assistantAudioPlaybackDurationMs = 0;
    this.eventCounter = 0;
    this.conversationItems = new Map<string, any>();
    this.truncatedAssistantItemIds = new Set<string>();
    this.functionCalls = new Map<string, any>();
    this.audioDone = false;
    this.responseInProgress = false;
    this.responseQueue = [];

    // オーディオ関連の初期化
    this.micInstance = null;
    this.speakerInstance = null;
    this.audioStream = null;
    this.audioStop = false;

    // WebSocketの初期化
    this.url = `wss://api.openai.com/v1/realtime?model=${this.MODEL_NAME}`;
    this.wsHeaders = {
      Authorization: `Bearer ${this.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    };

    this.ws = new WebSocket(this.url, {
      headers: this.wsHeaders,
    });

    this.ws.on("open", async () => {
      console.log("サーバーに接続しました。");
      await this.setupSession();
      this.startMicrophone();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      const event = JSON.parse(data.toString());
      this.handleEvent(event);
    });

    this.ws.on("close", () => {
      console.log("接続が閉じられました。");
    });

    this.ws.on("error", (err: Error) => {
      console.error("WebSocketエラー:", err);
    });

    // 動的ツールの初期化
    this.dynamicTools = new Map<string, ToolSearchApiResponse>();
    // ペンディング中の関数呼び出しを管理するマップ
    this.pendingFunctionCalls = new Map<string, Function>();

    // 最後にログを出力したインデックスの初期化
    this.lastLoggedIndex = 0;
  }

  // イベントIDを生成
  private generateEventId(): string {
    return `event_${this.eventCounter++}`;
  }

  // 初期設定を取得（外部APIから取得する場合はここで実装）
  private async getInitialSettings() {
    // ツール検索APIを呼び出す
    const apiUrl =
      process.env.ASSISTANT_HUB_BASE_URL ||
      "https://assistant-hub-zeta.vercel.app";
    const endpoint = `${apiUrl}/api/threads/${this.threadId}`;

    const apiKey = process.env.ASSISTANT_HUB_API_KEY;

    try {
      // axiosを使用してAPIを呼び出す
      const response = await axios.get(endpoint, {
        headers: {
          "X-Service-API-Key": apiKey,
          "Content-Type": "application/json",
        },
      });

      return response.data as Thread;
    } catch (e) {
      console.error(e);
      process.exit(0);
    }
  }

  // セッションの設定を送信
  private async setupSession() {
    const settings = await this.getInitialSettings();
    const instructions =
      `${settings.system_prompt}\n\n${settings.memory}`.replace(
        "<japanese_time>",
        new Date().toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
          timeZoneName: "short", // JST と表示
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    console.log(instructions);

    const functionsList: FunctionDef[] = [updateToolListFunction];

    const event = {
      event_id: this.generateEventId(),
      type: "session.update",
      session: {
        instructions,
        modalities: ["audio", "text"],
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools: functionsList,
      },
    };
    this.ws.send(JSON.stringify(event));
  }

  // マイクを開始
  private startMicrophone() {
    this.micInstance = mic({
      rate: "24000",
      channels: "1",
      bitwidth: "16",
      encoding: "signed-integer",
      endian: "little",
    });

    const micInputStream = this.micInstance.getAudioStream();

    micInputStream.on("data", (data: Buffer) => {
      const audioBase64 = data.toString("base64");
      const event = {
        type: "input_audio_buffer.append",
        audio: audioBase64,
      };
      this.ws.send(JSON.stringify(event));
    });

    micInputStream.on("error", (err: Error) => {
      console.error("マイク入力エラー:", err);
    });

    this.micInstance.start();
  }

  // 非アクティブタイマーをリセット
  private resetInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // 非アクティブタイマーを開始
  private startInactivityTimer() {
    if (
      this.isPlayingAudio ||
      this.isAssistantResponding ||
      this.isUserSpeaking
    ) {
      return;
    }
    this.resetInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      this.handleInactivityTimeout();
    }, 5000);
  }

  // 非アクティブタイマーのタイムアウト処理
  private handleInactivityTimeout() {
    console.log("5秒間発話がなかったため、セッションを終了します。");
    this.ws.close();
    process.exit(0);
  }

  // イベントを処理
  private async handleEvent(event: any) {
    const handlers: { [key: string]: Function } = {
      "session.created": this.handleSessionCreated.bind(this),
      "conversation.item.created":
        this.handleConversationItemCreated.bind(this),
      "conversation.item.input_audio_transcription.completed":
        this.handleInputAudioTranscriptionCompleted.bind(this),
      "response.created": this.handleResponseCreated.bind(this),
      "response.done": this.handleResponseDone.bind(this),
      "response.content_part.added":
        this.handleResponseContentPartAdded.bind(this),
      "response.text.delta": this.handleResponseTextDelta.bind(this),
      "response.text.done": this.handleResponseTextDone.bind(this),
      "response.audio_transcript.delta":
        this.handleResponseAudioTranscriptDelta.bind(this),
      "response.audio_transcript.done":
        this.handleResponseAudioTranscriptDone.bind(this),
      "response.audio.delta": this.handleResponseAudioDelta.bind(this),
      "response.audio.done": this.handleResponseAudioDone.bind(this),
      "input_audio_buffer.speech_started":
        this.handleInputAudioBufferSpeechStarted.bind(this),
      "input_audio_buffer.speech_stopped":
        this.handleInputAudioBufferSpeechStopped.bind(this),
      "conversation.item.truncated":
        this.handleConversationItemTruncated.bind(this),
      "response.function_call_arguments.delta":
        this.handleResponseFunctionCallArgumentsDelta.bind(this),
      "response.function_call_arguments.done":
        this.handleResponseFunctionCallArgumentsDone.bind(this),
      error: this.handleError.bind(this),
    };

    const handler = handlers[event.type];
    if (handler) {
      await handler(event);
    } else {
      // 未処理のイベント
    }
  }

  // セッションが作成されたときの処理
  private handleSessionCreated(event: any) {
    console.log("セッションが作成されました。");
  }

  // 会話アイテムが作成されたときの処理
  private async handleConversationItemCreated(event: any) {
    const item = event.item;
    this.conversationItems.set(item.id, item);

    if (item.type === "function_call") {
      await this.handleFunctionCall(item);
    } else if (item.role === "assistant") {
      this.resetInactivityTimer();
      this.lastAssistantItemId = item.id;
      this.assistantAudioContentIndex = 0;
      this.assistantAudioDurationMs = 0;
      this.assistantAudioPlaybackDurationMs = 0;
      this.truncatedAssistantItemIds.clear();
      this.conversationHistory.push({
        role: item.role,
        content: "",
        item_id: item.id,
      });

      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );
    } else if (item.role === "user") {
      this.resetInactivityTimer();
      // ユーザーメッセージを会話履歴に追加（内容はまだ空）
      this.conversationHistory.push({
        role: item.role,
        content: "",
        item_id: item.id,
      });

      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );
    }
  }

  // 関数呼び出しの処理
  private async handleFunctionCall(item: any) {
    const functionName = item.name;
    const callId = item.call_id;

    this.functionCalls.set(callId, {
      item_id: item.id,
      function_name: functionName,
      arguments: "",
    });

    this.conversationHistory.push({
      role: "assistant",
      type: "function_call",
      function_name: functionName,
      content: "",
      item_id: item.id,
    });

    // 新しいメッセージをログに出力
    this.logNewMessage(
      this.conversationHistory[this.conversationHistory.length - 1]
    );

    if (functionName === "update_tools_list") {
      // ユーザーの最新の入力が利用可能か確認
      const lastMessages = this.getLastNMessages(5);
      if (lastMessages.length > 0) {
        // ユーザー入力がすでに利用可能
        await this.handleUpdateToolsList(callId, lastMessages);
      } else {
        // ユーザー入力がまだ利用できないので、ペンディングに追加
        this.pendingFunctionCalls.set(callId, async () => {
          await this.handleUpdateToolsList(callId, this.getLastNMessages(5));
        });
      }
    } else {
      // 他の動的に取得した関数が呼び出された場合
      // 引数がまだ収集されていないため、ペンディングに追加
      this.pendingFunctionCalls.set(callId, async () => {
        await this.handleDynamicFunctionCall(functionName, callId);
      });
    }
  }

  // 最新のN件のメッセージを取得
  private getLastNMessages(n: number): any[] {
    return this.conversationHistory.slice(-n);
  }

  // update_tools_listを処理（axiosを使用）
  private async handleUpdateToolsList(callId: string, lastMessages: any[]) {
    // 最後のN件のメッセージを取得
    const messages = lastMessages
      .map((msg) => {
        if (msg.role === "user" || msg.role === "assistant") {
          return msg.content;
        }
        return "";
      })
      .join("\n");

    console.log(`ツール更新のための会話履歴:\n${messages}`);

    // ツール検索APIを呼び出す
    const apiUrl =
      process.env.ASSISTANT_HUB_BASE_URL ||
      "https://assistant-hub-zeta.vercel.app";
    const searchEndpoint = `${apiUrl}/api/tools/search`;

    const apiKey = process.env.ASSISTANT_HUB_API_KEY;

    try {
      // axiosを使用してAPIを呼び出す
      const response = await axios.post(
        searchEndpoint,
        {
          query: messages,
          openai_tools_mode: true,
        },
        {
          headers: {
            "X-Service-API-Key": apiKey,
            "Content-Type": "application/json",
          },
        }
      );

      const results = response.data as ToolSearchApiResponse[];

      // 動的ツールのマップを初期化
      this.dynamicTools = new Map<string, ToolSearchApiResponse>();

      const functionsList: FunctionDef[] = [];

      for (const result of results) {
        const functionDef = result.function;
        const toolId = result.baseTool.id;

        if (!toolId) {
          console.error(
            `関数${functionDef.name}のツールIDが見つかりませんでした。`
          );
          continue;
        }

        functionsList.push({
          ...functionDef,
          type: "function",
          baseTool: undefined,
        });

        // 関数名からツールIDへのマッピングを保存
        this.dynamicTools.set(functionDef.name, result);
      }

      // 'update_tools_list'を追加
      functionsList.push(updateToolListFunction);

      // セッションのツールを更新
      this.updateFunctions(functionsList);

      // 関数の出力をアシスタントに送信
      const resultMessage = { message: "ツールリストが更新されました。" };

      const event = {
        event_id: this.generateEventId(),
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(resultMessage),
        },
      };
      this.ws.send(JSON.stringify(event));

      // 会話履歴を更新
      this.conversationHistory.push({
        role: "function",
        type: "function_call_output",
        function_name: "update_tools_list",
        content: JSON.stringify(resultMessage),
        item_id: this.generateEventId(),
      });

      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );

      // 関数呼び出しをペンディングリストから削除
      this.pendingFunctionCalls.delete(callId);

      // アシスタントの応答をトリガー
      this.sendResponseCreateEvent({
        event_id: this.generateEventId(),
        type: "response.create",
        response: {},
      });
    } catch (error: any) {
      if (error.response) {
        console.error(
          `ツール検索APIリクエストがステータス${error.response.status}で失敗しました`
        );
        console.error("レスポンスデータ:", error.response.data);
      } else {
        console.error(
          "ツール検索APIの呼び出し中にエラーが発生しました:",
          error.message
        );
      }
    }
  }

  // 動的に取得した関数呼び出しを処理（axiosを使用）
  private async handleDynamicFunctionCall(
    functionName: string,
    callId: string
  ) {
    const functionCall = this.functionCalls.get(callId);
    if (!functionCall) {
      console.error(`callId ${callId}に対応する関数呼び出しが見つかりません。`);
      return;
    }

    // 関数の引数が収集されるのを待つ
    // functionCall.argumentsはhandleResponseFunctionCallArgumentsDeltaとhandleResponseFunctionCallArgumentsDoneで更新されます

    let args;
    try {
      args = JSON.parse(functionCall.arguments);
    } catch (err) {
      console.error("関数引数の解析に失敗しました:", err);
      args = {};
    }

    // dynamicToolsからツール情報を取得
    const toolInfo = this.dynamicTools.get(functionName);

    if (!toolInfo) {
      console.error(`関数${functionName}が動的ツールに見つかりませんでした。`);

      // エラーメッセージをアシスタントに返す
      const errorMessage = {
        error: `関数${functionName}が見つかりませんでした。`,
      };

      const event = {
        event_id: this.generateEventId(),
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(errorMessage),
        },
      };
      this.ws.send(JSON.stringify(event));

      // 会話履歴を更新
      this.conversationHistory.push({
        role: "function",
        type: "function_call_output",
        function_name: functionName,
        content: JSON.stringify(errorMessage),
        item_id: this.generateEventId(),
      });

      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );

      // 関数呼び出しをペンディングリストから削除
      this.pendingFunctionCalls.delete(callId);

      // アシスタントの応答をトリガー
      this.sendResponseCreateEvent({
        event_id: this.generateEventId(),
        type: "response.create",
        response: {},
      });

      return;
    }

    const toolId = toolInfo.baseTool.id;

    // ログに動的ツールの呼び出しを表示
    console.log(`動的ツールが呼び出されました: ${toolInfo.baseTool.name}`);

    // ツール実行APIを呼び出す
    const apiUrl =
      process.env.ASSISTANT_HUB_BASE_URL ||
      "https://assistant-hub-zeta.vercel.app";
    const executeEndpoint = `${apiUrl}/api/tools/${toolId}/execute`;

    const apiKey = process.env.ASSISTANT_HUB_API_KEY;

    const path = toolInfo.path;
    const method = toolInfo.method;

    try {
      // axiosを使用してAPIを呼び出す
      const response = await axios.post(
        executeEndpoint,
        {
          arguments: JSON.stringify(args),
          path: path,
          method: method,
        },
        {
          headers: {
            "X-Service-API-Key": apiKey,
            "Content-Type": "application/json",
          },
        }
      );

      const result = response.data;

      // 関数の出力をアシスタントに送信
      const event = {
        event_id: this.generateEventId(),
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      };
      this.ws.send(JSON.stringify(event));

      // 会話履歴を更新
      this.conversationHistory.push({
        role: "function",
        type: "function_call_output",
        function_name: functionName,
        content: JSON.stringify(result),
        item_id: this.generateEventId(),
      });

      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );

      // 関数呼び出しをペンディングリストから削除
      this.pendingFunctionCalls.delete(callId);

      // アシスタントの応答をトリガー
      this.sendResponseCreateEvent({
        event_id: this.generateEventId(),
        type: "response.create",
        response: {},
      });
    } catch (error: any) {
      if (error.response) {
        console.error(
          `ツール実行APIリクエストがステータス${error.response.status}で失敗しました`
        );
        console.error("レスポンスデータ:", error.response.data);
      } else {
        console.error(
          "ツール実行APIの呼び出し中にエラーが発生しました:",
          error.message
        );
      }
    }
  }

  // ユーザーの音声入力がトランスクリプトされたときの処理
  private handleInputAudioTranscriptionCompleted(event: any) {
    const itemId = event.item_id;
    const transcript = event.transcript;
    const item = this.conversationItems.get(itemId);

    if (item) {
      const contentIndex = event.content_index;
      if (item.content && item.content.length > contentIndex) {
        item.content[contentIndex].transcript = transcript;
      }
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.item_id === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          item_id: itemId,
        });
      }
      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );

      // ペンディング中の関数呼び出しがあれば処理
      this.pendingFunctionCalls.forEach(async (func, pendingCallId) => {
        await func();
        this.pendingFunctionCalls.delete(pendingCallId);
      });
    }
  }

  // レスポンスが作成されたときの処理
  private handleResponseCreated(event: any) {
    this.isAssistantResponding = true;
    this.resetInactivityTimer();
    this.audioDone = false; // 音声データの受信開始
    this.responseInProgress = true; // レスポンスが進行中であることを設定
  }

  // レスポンスが完了したときの処理
  private handleResponseDone(event: any) {
    this.isAssistantResponding = false;
    this.responseInProgress = false; // レスポンスが完了したのでフラグをリセット

    // キューに保留中のレスポンスがあれば送信
    if (this.responseQueue.length > 0) {
      const nextResponseEvent = this.responseQueue.shift();
      this.sendResponseCreateEvent(nextResponseEvent);
    }

    // this.startInactivityTimer() は audioStream の end イベントで行う
  }

  // レスポンスのコンテンツパートが追加されたときの処理
  private handleResponseContentPartAdded(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const part = event.part;
    const item = this.conversationItems.get(itemId);
    if (item) {
      item.content = item.content || [];
      while (item.content.length <= contentIndex) {
        item.content.push({});
      }
      item.content[contentIndex] = part;
    }
  }

  // レスポンスのテキストが更新されたときの処理
  private handleResponseTextDelta(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const delta = event.delta;
    const item = this.conversationItems.get(itemId);
    if (item && item.content && item.content.length > contentIndex) {
      item.content[contentIndex].text =
        (item.content[contentIndex].text || "") + delta;
    }
  }

  // レスポンスのテキストが完了したときの処理
  private handleResponseTextDone(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const text = event.text;
    const item = this.conversationItems.get(itemId);

    if (item && item.content && item.content.length > contentIndex) {
      item.content[contentIndex].text = text;
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.item_id === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          item_id: itemId,
        });
      }
      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );
    }
  }

  // レスポンスの音声トランスクリプトが更新されたときの処理
  private handleResponseAudioTranscriptDelta(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const delta = event.delta;
    const item = this.conversationItems.get(itemId);
    if (item && item.content && item.content.length > contentIndex) {
      item.content[contentIndex].transcript =
        (item.content[contentIndex].transcript || "") + delta;
    }
  }

  // レスポンスの音声トランスクリプトが完了したときの処理
  private handleResponseAudioTranscriptDone(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const transcript = event.transcript;
    const item = this.conversationItems.get(itemId);

    if (item && item.content && item.content.length > contentIndex) {
      item.content[contentIndex].transcript = transcript;
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.item_id === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          item_id: itemId,
        });
      }
      // 新しいメッセージをログに出力
      this.logNewMessage(
        this.conversationHistory[this.conversationHistory.length - 1]
      );
    }
  }

  // レスポンスの音声データが更新されたときの処理
  private handleResponseAudioDelta(event: any) {
    const itemId = event.item_id;

    if (this.truncatedAssistantItemIds.has(itemId)) {
      return;
    }

    const audioDeltaBase64 = event.delta;
    const audioDelta = Buffer.from(audioDeltaBase64, "base64");

    // 音声再生が開始されていない場合は初期化
    if (!this.isPlayingAudio) {
      this.isPlayingAudio = true;

      // 新たにPassThroughストリームを作成
      this.audioStream = new PassThrough();

      // スピーカーインスタンスを作成
      this.speakerInstance = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 24000,
      });

      // ストリームをスピーカーにパイプ
      this.audioStream.pipe(this.speakerInstance);

      // ストリームのデータイベントで音声データの長さを計測
      this.audioStream.on("data", (chunk: Buffer) => {
        const chunkDurationMs = (chunk.length / 2 / 24000) * 1000;
        this.assistantAudioPlaybackDurationMs += chunkDurationMs;
      });

      // スピーカーの終了イベント
      this.speakerInstance.on("close", () => {
        this.isPlayingAudio = false;
        this.speakerInstance = null;
        this.audioStream = null;
        this.startInactivityTimer();
      });

      // スピーカーのエラーイベント
      this.speakerInstance.on("error", (err) => {
        console.error("Speakerエラー:", err);
        this.isPlayingAudio = false;
        this.speakerInstance = null;
        this.audioStream = null;
        this.startInactivityTimer();
      });
    }

    // オーディオデータをストリームに書き込む
    if (this.audioStream && this.speakerInstance) {
      this.audioStream.write(audioDelta);
    }

    const deltaBytes = audioDelta.length;
    const deltaDurationMs = (deltaBytes / 2 / 24000) * 1000;
    this.assistantAudioDurationMs += deltaDurationMs;
  }

  // レスポンスの音声データが完了したときの処理
  private handleResponseAudioDone(event: any) {
    this.audioDone = true; // 音声データの受信完了を設定
    if (this.audioStream) {
      this.audioStream.end(); // ストリームを終了
    }
  }

  // ユーザーの発話が開始されたときの処理
  private handleInputAudioBufferSpeechStarted(event: any) {
    console.log("ユーザーの発話が検出されました。");
    this.isUserSpeaking = true;
    if (this.isPlayingAudio && this.lastAssistantItemId) {
      this.truncateAssistantSpeech(
        this.lastAssistantItemId,
        this.assistantAudioContentIndex!
      );
      this.stopAudioPlayback();
    }
    this.resetInactivityTimer();
  }

  // ユーザーの発話が終了したときの処理
  private handleInputAudioBufferSpeechStopped(event: any) {
    console.log("ユーザーの発話が終了しました。");
    this.isUserSpeaking = false;
    this.startInactivityTimer();
  }

  // 会話アイテムがトランケートされたときの処理
  private handleConversationItemTruncated(event: any) {
    const itemId = event.item_id;
    this.truncatedAssistantItemIds.add(itemId);
  }

  // 関数呼び出しの引数が更新されたときの処理
  private handleResponseFunctionCallArgumentsDelta(event: any) {
    const callId = event.call_id;
    const delta = event.delta;
    const functionCall = this.functionCalls.get(callId);
    if (functionCall) {
      functionCall.arguments += delta;
    }
  }

  // 関数呼び出しの引数が完了したときの処理
  private async handleResponseFunctionCallArgumentsDone(event: any) {
    const callId = event.call_id;
    const argumentsStr = event.arguments;
    const functionCall = this.functionCalls.get(callId);

    if (functionCall) {
      functionCall.arguments = argumentsStr;

      if (functionCall.function_name !== "update_tools_list") {
        await this.handleDynamicFunctionCall(
          functionCall.function_name,
          callId
        );
        // 関数呼び出しをクリーンアップ
        this.functionCalls.delete(callId);
      }
    }
  }

  // エラーが発生したときの処理
  private handleError(event: any) {
    console.error("エラーが発生しました:", event.error);
  }

  // コンテンツを抽出
  private extractContent(contentArray: any[]): string {
    if (!Array.isArray(contentArray)) return "";
    let contentText = "";
    for (const contentPart of contentArray) {
      if (contentPart.type === "text" && contentPart.text) {
        contentText += contentPart.text;
      } else if (contentPart.type === "input_audio" && contentPart.transcript) {
        contentText += contentPart.transcript;
      } else if (contentPart.type === "input_text" && contentPart.text) {
        contentText += contentPart.text;
      } else if (contentPart.type === "audio" && contentPart.transcript) {
        contentText += contentPart.transcript;
      }
    }
    return contentText || "";
  }

  // オーディオ再生を停止
  private stopAudioPlayback() {
    this.isPlayingAudio = false;
    this.audioDone = true; // 受信完了を設定

    if (this.audioStream) {
      this.audioStream.end(); // ストリームを終了
      this.audioStream = null;
    }

    if (this.speakerInstance) {
      this.speakerInstance.end(); // スピーカーを終了
      this.speakerInstance = null;
    }

    this.startInactivityTimer();
  }

  // 会話履歴を出力（新しいメッセージのみ）
  private logNewMessage(message: any) {
    const role = message.role;
    const content = message.content || "[No content]";
    if (message.type === "function_call") {
      console.log(
        `${role}が関数 ${message.function_name} を呼び出しました。引数: ${content}`
      );
    } else if (message.type === "function_call_output") {
      console.log(
        `関数 ${message.function_name} の戻り値: ${
          content.slice(0, 50) + content.length > 50 ? "..." : ""
        }`
      );
    } else {
      if (content) {
        console.log(`${role}: ${content}`);
      }
    }
    // 最後にログを出力したインデックスを更新
    this.lastLoggedIndex = this.conversationHistory.length;
  }

  // セッションのツールリストを更新
  public updateFunctions(functionsList: FunctionDef[]) {
    const event = {
      event_id: this.generateEventId(),
      type: "session.update",
      session: {
        tools: functionsList,
      },
    };
    this.ws.send(JSON.stringify(event));
  }

  // アシスタントの発話をトランケート
  public truncateAssistantSpeech(itemId: string, contentIndex: number) {
    const audioEndMs = Math.round(this.assistantAudioPlaybackDurationMs);

    const event = {
      event_id: this.generateEventId(),
      type: "conversation.item.truncate",
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEndMs,
    };
    this.ws.send(JSON.stringify(event));

    this.truncatedAssistantItemIds.add(itemId);
  }

  // レスポンスを送信するヘルパーメソッド
  private sendResponseCreateEvent(event: any) {
    if (!this.responseInProgress) {
      this.ws.send(JSON.stringify(event));
      this.responseInProgress = true;
    } else {
      this.responseQueue.push(event);
    }
  }

  // クリーンアップ処理
  public close() {
    this.audioStop = true;
    if (this.micInstance) {
      this.micInstance.stop();
    }
    if (this.audioStream) {
      this.audioStream.end();
    }
    if (this.speakerInstance) {
      this.speakerInstance.end();
    }
  }
}

// 実行部分
const chat = new RealtimeChat();

process.on("SIGINT", () => {
  console.log("ユーザーによって中断されました。");
  chat.close();
  process.exit(0);
});
