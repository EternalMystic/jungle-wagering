import { InvalidMessageStateError, InvariantViolationError } from "./errors";

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt: Date | undefined;
}

/**
 * Registro de deduplicação da fila: PK (consumerName, messageId) no banco. A mesma
 * mensagem com hash diferente não é redelivery — é veneno (D9, permanente).
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.length === 0 || props.consumerName.length === 0) {
      throw new InvariantViolationError("messageId and consumerName are required");
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvariantViolationError("payloadHash must be 64 lowercase hex chars (SHA-256)");
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidMessageStateError(`inbox message ${this.consumerName}/${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
