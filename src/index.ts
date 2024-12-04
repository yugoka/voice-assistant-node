import WebSocket from "ws";
import dotenv from "dotenv";
import mic from "mic";
import Speaker from "speaker";
import { PassThrough } from "stream";
import { Readable } from "stream";

dotenv.config();

class RealtimeChat {
  private OPENAI_API_KEY: string;
  private MODEL_NAME: string;

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

  // オーディオ関連
  private micInstance: any;
  private speakerInstance: Speaker | null;
  private audioStream: PassThrough | null;
  private audioStop: boolean;

  // WebSocket
  private ws: WebSocket;
  private url: string;
  private wsHeaders: any;

  constructor() {
    // 設定
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    this.MODEL_NAME = "gpt-4o-realtime-preview-2024-10-01";

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
      console.log("Connected to the server.");
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

  private generateEventId(): string {
    return `event_${this.eventCounter++}`;
  }

  private async getInitialSettings() {
    // 外部APIから設定を取得する処理を実装する場合はここに記述
    return {
      instructions: "あなたは親切なアシスタントです。",
    };
  }

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

  private resetInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

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

  private handleInactivityTimeout() {
    console.log("5秒間発話がなかったため、セッションを終了します。");
    this.ws.close();
    process.exit(0);
  }

  private handleEvent(event: any) {
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
      handler(event);
    } else {
      // 未処理のイベント
    }
  }

  private handleSessionCreated(event: any) {
    console.log("セッションが作成されました。");
  }

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
        item_id: item.id,
      });
    } else if (item.role === "user") {
      this.resetInactivityTimer();
    }
  }

  private handleFunctionCall(item: any) {
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
  }

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
      this.outputConversationLog();
    }
  }

  private handleResponseCreated(event: any) {
    this.isAssistantResponding = true;
    this.resetInactivityTimer();
    this.audioDone = false; // 音声データの受信開始
  }

  private handleResponseDone(event: any) {
    this.isAssistantResponding = false;
    // this.startInactivityTimer() は audioStream の end イベントで行う
  }

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
      this.outputConversationLog();
    }
  }

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
    }
  }

  private handleResponseAudioDelta(event: any) {
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

  private handleResponseAudioDone(event: any) {
    this.audioDone = true; // 音声データの受信完了を設定
    if (this.audioStream) {
      this.audioStream.end();
    }
  }

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

  private handleInputAudioBufferSpeechStopped(event: any) {
    console.log("ユーザーの発話が終了しました。");
    this.isUserSpeaking = false;
    this.startInactivityTimer();
  }

  private handleConversationItemTruncated(event: any) {
    const itemId = event.item_id;
    this.truncatedAssistantItemIds.add(itemId);
  }

  private handleResponseFunctionCallArgumentsDelta(event: any) {
    const callId = event.call_id;
    const delta = event.delta;
    const functionCall = this.functionCalls.get(callId);
    if (functionCall) {
      functionCall.arguments += delta;
    }
  }

  private async handleResponseFunctionCallArgumentsDone(event: any) {
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

      if (functionCall.function_name === "get_weather") {
        result = this.mockGetWeather(args.location);
      } else {
        result = { error: "未知の関数: " + functionCall.function_name };
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
        function_name: functionCall.function_name,
        content: JSON.stringify(result),
        item_id: this.generateEventId(),
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

  private handleError(event: any) {
    console.error("エラーが発生しました:", event.error);
  }

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

  private stopAudioPlayback() {
    this.isPlayingAudio = false;
    this.audioDone = true; // 受信完了を設定

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

  private outputConversationLog() {
    console.log("会話履歴:");
    this.conversationHistory.forEach((item) => {
      const role = item.role;
      const content = item.content || "[No content]";
      if (item.type === "function_call") {
        console.log(
          `${role}が関数 ${item.function_name} を呼び出しました。引数: ${content}`
        );
      } else if (item.type === "function_call_output") {
        console.log(`関数 ${item.function_name} の戻り値: ${content}`);
      } else {
        console.log(`${role}: ${content}`);
      }
    });
  }

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

  private mockGetWeather(location: string) {
    return {
      location: location,
      forecast: "晴れ時々曇り",
      temperature: "25°C",
    };
  }

  public close() {
    // クリーンアップ
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
