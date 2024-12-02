import WebSocket from "ws";
import dotenv from "dotenv";
import mic from "mic";
import Speaker from "speaker";
import { PassThrough } from "stream";

dotenv.config();

class RealtimeChat {
  private OPENAI_API_KEY: string;
  private MODEL_NAME: string;
  private conversationHistory: any[];
  private ws: WebSocket;
  private micInstance: any;
  private inactivityTimer: NodeJS.Timeout | null;
  private isPlayingAudio: boolean;
  private isAssistantResponding: boolean;
  private isUserSpeaking: boolean;
  private lastAssistantItemId: string | null;
  private assistantAudioContentIndex: number | null;
  private assistantAudioDurationMs: number;
  private assistantAudioPlaybackDurationMs: number;
  private eventCounter: number = 0;
  private conversationItems: Map<string, any>;
  private speakerInstance: Speaker | null;
  private audioStream: PassThrough | null;
  private truncatedAssistantItemIds: Set<string>;
  private functionCalls: Map<string, any>;

  constructor() {
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    this.MODEL_NAME = "gpt-4o-realtime-preview-2024-10-01";
    this.conversationHistory = [];
    this.inactivityTimer = null;
    this.isPlayingAudio = false;
    this.isAssistantResponding = false;
    this.isUserSpeaking = false;
    this.lastAssistantItemId = null;
    this.assistantAudioContentIndex = null;
    this.assistantAudioDurationMs = 0;
    this.assistantAudioPlaybackDurationMs = 0;
    this.conversationItems = new Map<string, any>();
    this.speakerInstance = null;
    this.audioStream = null;
    this.truncatedAssistantItemIds = new Set<string>();
    this.functionCalls = new Map<string, any>();

    const url = `wss://api.openai.com/v1/realtime?model=${this.MODEL_NAME}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
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
  }

  // イベントIDを生成
  private generateEventId(): string {
    return `event_${this.eventCounter++}`;
  }

  // 初期設定を取得（プレースホルダー）
  private async getInitialSettings() {
    // TODO: 必要に応じて外部APIから設定を取得する処理を実装
    return {
      instructions: "あなたは親切なアシスタントです。",
    };
  }

  // サーバーとのセッションをセットアップ
  private async setupSession() {
    const settings = await this.getInitialSettings();

    const functionsList = [
      {
        type: "function",
        name: "get_weather",
        description: "現在の天気を取得します。",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
    ];

    const event = {
      event_id: this.generateEventId(),
      type: "session.update",
      session: {
        instructions: settings.instructions,
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

  // マイクからの音声キャプチャを開始
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

  // 不活性タイマーをリセット
  private resetInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // 不活性タイマーを開始
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
      console.log("5秒間発話がなかったため、セッションを終了します。");
      this.ws.close();
      process.exit(0);
    }, 5000);
  }

  // サーバーからのイベントを処理
  private handleEvent(event: any) {
    switch (event.type) {
      case "session.created":
        console.log("セッションが作成されました。");
        break;

      case "conversation.item.created":
        this.handleConversationItemCreated(event);
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.handleInputAudioTranscriptionCompleted(event);
        break;

      case "response.created":
        this.isAssistantResponding = true;
        this.resetInactivityTimer();
        break;

      case "response.done":
        this.isAssistantResponding = false;
        this.startInactivityTimer();
        break;

      case "response.content_part.added":
        this.handleResponseContentPartAdded(event);
        break;

      case "response.text.delta":
        this.handleResponseTextDelta(event);
        break;

      case "response.text.done":
        this.handleResponseTextDone(event);
        break;

      case "response.audio_transcript.delta":
        this.handleResponseAudioTranscriptDelta(event);
        break;

      case "response.audio_transcript.done":
        this.handleResponseAudioTranscriptDone(event);
        break;

      case "response.audio.delta":
        this.handleAudioDelta(event);
        break;

      case "response.audio.done":
        this.handleAudioDone(event);
        break;

      case "input_audio_buffer.speech_started":
        console.log("ユーザーの発話が検出されました。");
        this.isUserSpeaking = true;
        if (this.isPlayingAudio && this.lastAssistantItemId !== null) {
          this.stopAudioPlayback();
        }
        this.resetInactivityTimer();
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("ユーザーの発話が終了しました。");
        this.isUserSpeaking = false;
        this.startInactivityTimer();
        break;

      case "conversation.item.truncated":
        this.truncatedAssistantItemIds.add(event.item_id);
        break;

      case "response.function_call_arguments.delta":
        this.handleFunctionCallArgumentsDelta(event);
        break;

      case "response.function_call_arguments.done":
        this.handleFunctionCallArgumentsDone(event);
        break;

      case "error":
        console.error("エラーが発生しました:", event.error);
        break;

      default:
        // その他のイベントを処理
        break;
    }
  }

  // コンテンツからテキストを抽出
  private extractContent(contentArray: any[]): string {
    if (!Array.isArray(contentArray)) return "[No content]";
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
    return contentText || "[No content]";
  }

  // 会話アイテムが作成されたときの処理
  private handleConversationItemCreated(event: any) {
    const item = event.item;
    this.conversationItems.set(item.id, item);

    if (item.type === "function_call") {
      this.handleFunctionCall(item);
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
        itemId: item.id,
      });
    } else if (item.role === "user") {
      this.resetInactivityTimer();
    }
  }

  // 関数呼び出しの処理
  private handleFunctionCall(item: any) {
    const functionName = item.name;
    const callId = item.call_id;

    this.functionCalls.set(callId, {
      itemId: item.id,
      functionName: functionName,
      arguments: "",
    });

    this.conversationHistory.push({
      role: "assistant",
      type: "function_call",
      functionName: functionName,
      content: "",
      itemId: item.id,
    });
  }

  // ユーザー音声の転写が完了したときの処理
  private handleInputAudioTranscriptionCompleted(event: any) {
    const itemId = event.item_id;
    const transcript = event.transcript;
    const item = this.conversationItems.get(itemId);

    if (item) {
      const contentIndex = event.content_index;
      if (item.content && item.content[contentIndex]) {
        item.content[contentIndex].transcript = transcript;
      }
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.itemId === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          itemId: itemId,
        });
      }
      this.outputConversationLog();
    }
  }

  // レスポンスのコンテンツパートが追加されたときの処理
  private handleResponseContentPartAdded(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const part = event.part;
    const item = this.conversationItems.get(itemId);
    if (item) {
      item.content = item.content || [];
      item.content[contentIndex] = part;
    }
  }

  // レスポンスのテキストデルタを処理
  private handleResponseTextDelta(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const delta = event.delta;
    const item = this.conversationItems.get(itemId);
    if (item && item.content && item.content[contentIndex]) {
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

    if (item && item.content && item.content[contentIndex]) {
      item.content[contentIndex].text = text;
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.itemId === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          itemId: itemId,
        });
      }
      this.outputConversationLog();
    }
  }

  // レスポンスの音声転写デルタを処理
  private handleResponseAudioTranscriptDelta(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const delta = event.delta;
    const item = this.conversationItems.get(itemId);
    if (item && item.content && item.content[contentIndex]) {
      item.content[contentIndex].transcript =
        (item.content[contentIndex].transcript || "") + delta;
    }
  }

  // レスポンスの音声転写が完了したときの処理
  private handleResponseAudioTranscriptDone(event: any) {
    const itemId = event.item_id;
    const contentIndex = event.content_index;
    const transcript = event.transcript;
    const item = this.conversationItems.get(itemId);

    if (item && item.content && item.content[contentIndex]) {
      item.content[contentIndex].transcript = transcript;
      const content = this.extractContent(item.content);
      const index = this.conversationHistory.findIndex(
        (msg) => msg.itemId === itemId
      );
      if (index !== -1) {
        this.conversationHistory[index].content = content;
      } else {
        this.conversationHistory.push({
          role: item.role,
          content: content,
          itemId: itemId,
        });
      }
    }
  }

  // サーバーからのオーディオデルタを処理
  private handleAudioDelta(event: any) {
    const itemId = event.item_id;

    if (this.truncatedAssistantItemIds.has(itemId)) {
      return;
    }

    const audioDeltaBase64 = event.delta;
    const audioDelta = Buffer.from(audioDeltaBase64, "base64");

    if (!this.audioStream) {
      this.audioStream = new PassThrough();

      this.speakerInstance = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 24000,
      });

      this.isPlayingAudio = true;

      this.audioStream.on("data", (chunk: Buffer) => {
        const chunkDurationMs = (chunk.length / 2 / 24000) * 1000;
        this.assistantAudioPlaybackDurationMs += chunkDurationMs;
      });

      this.audioStream.pipe(this.speakerInstance);

      this.speakerInstance.on("close", () => {
        this.isPlayingAudio = false;
        this.speakerInstance = null;
        this.audioStream = null;
        this.startInactivityTimer();
      });

      this.speakerInstance.on("error", (err) => {
        console.error("Speakerエラー:", err);
        this.isPlayingAudio = false;
        this.speakerInstance = null;
        this.audioStream = null;
        this.startInactivityTimer();
      });
    }

    if (!this.isPlayingAudio || !this.audioStream || !this.speakerInstance) {
      return;
    }

    this.audioStream.write(audioDelta);

    const deltaBytes = audioDelta.length;
    const deltaDurationMs = (deltaBytes / 2 / 24000) * 1000;
    this.assistantAudioDurationMs += deltaDurationMs;
  }

  // サーバーからのオーディオ再生が完了したときの処理
  private async handleAudioDone(event: any) {
    if (this.audioStream) {
      this.audioStream.end();
    }
  }

  // 音声再生を停止
  private stopAudioPlayback() {
    this.isPlayingAudio = false;

    if (this.audioStream) {
      this.audioStream.unpipe();
      this.audioStream.end();
      this.audioStream = null;
    }

    if (this.speakerInstance) {
      this.speakerInstance.end();
      this.speakerInstance = null;
    }

    this.startInactivityTimer();
  }

  // 会話履歴を出力
  private outputConversationLog() {
    console.log("会話履歴:");
    this.conversationHistory.forEach((item) => {
      const role = item.role;
      const content = item.content || "[No content]";
      if (item.type === "function_call") {
        console.log(
          `${role}が関数 ${item.functionName} を呼び出しました。引数: ${content}`
        );
      } else if (item.type === "function_call_output") {
        console.log(`関数 ${item.functionName} の戻り値: ${content}`);
      } else {
        console.log(`${role}: ${content}`);
      }
    });
  }

  // Functionsを更新
  public updateFunctions(functionsList: any[]) {
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

  // 関数呼び出しの引数のデルタを処理
  private handleFunctionCallArgumentsDelta(event: any) {
    const callId = event.call_id;
    const delta = event.delta;
    const functionCall = this.functionCalls.get(callId);

    if (functionCall) {
      functionCall.arguments += delta;
    }
  }

  // 関数呼び出しの引数が完了したときの処理
  private handleFunctionCallArgumentsDone(event: any) {
    const callId = event.call_id;
    const argumentsStr = event.arguments;
    const functionCall = this.functionCalls.get(callId);

    if (functionCall) {
      functionCall.arguments = argumentsStr;
      let args;
      try {
        args = JSON.parse(argumentsStr);
      } catch (err) {
        console.error("関数引数の解析に失敗しました:", err);
        args = {};
      }

      let result;

      if (functionCall.functionName === "get_weather") {
        result = this.mockGetWeather(args.location);
      } else {
        result = { error: "未知の関数: " + functionCall.functionName };
      }

      // 関数の出力をサーバーに送信
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

      // 会話履歴に関数の出力を追加
      this.conversationHistory.push({
        role: "function",
        type: "function_call_output",
        functionName: functionCall.functionName,
        content: JSON.stringify(result),
        itemId: this.generateEventId(),
      });

      // 会話履歴を出力
      this.outputConversationLog();

      // アシスタントの応答をトリガー
      const responseEvent = {
        event_id: this.generateEventId(),
        type: "response.create",
        response: {},
      };
      this.ws.send(JSON.stringify(responseEvent));

      // クリーンアップ
      this.functionCalls.delete(callId);
    }
  }

  // モックの天気取得関数
  private mockGetWeather(location: string) {
    return {
      location: location,
      forecast: "晴れ時々曇り",
      temperature: "25°C",
    };
  }
}

// チャットをインスタンス化して実行
const chat = new RealtimeChat();
