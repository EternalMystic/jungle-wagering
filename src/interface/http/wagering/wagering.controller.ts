import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { WagerCommand, WagerResult } from "../../../application/process-wager-transaction";
import type { WagerTransaction } from "../../../domain/wager-transaction";
import { HttpProblem, type HttpResponse } from "../http-problem";
import {
  type TransactionResponse,
  type WagerResponse,
  correlationIdFrom,
  parseIdempotencyKey,
  parseWagerCommand,
  transactionResponse,
  wagerHttpStatus,
  wagerResponse,
} from "./dto";
import { ID_GENERATOR, PROCESS_WAGER_TRANSACTION, WAGERING_QUERIES } from "./tokens";
import { notFoundUnlessUuid } from "./wallets.controller";

interface ProcessWagerPort {
  execute(command: WagerCommand): Promise<WagerResult>;
}
interface TransactionQueriesPort {
  transaction(transactionId: string): Promise<WagerTransaction | undefined>;
  transactionByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}
interface IdPort {
  next(): string;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER_TRANSACTION) private readonly processWager: ProcessWagerPort,
    @Inject(WAGERING_QUERIES) private readonly queries: TransactionQueriesPort,
    @Inject(ID_GENERATOR) private readonly ids: IdPort,
  ) {}

  /**
   * 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (mesmo corpo) · 400 payload/header ·
   * 409 conflito de idempotência · 503 transitório (D5). A resposta só sai depois do COMMIT.
   */
  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Headers("x-correlation-id") correlation: unknown,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<WagerResponse> {
    const key = parseIdempotencyKey(idempotencyKey);
    const command = parseWagerCommand(body, key, correlationIdFrom(correlation, () => this.ids.next()));
    const result = await this.processWager.execute(command);
    res.status(wagerHttpStatus(result.status));
    return wagerResponse(result);
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string): Promise<TransactionResponse> {
    const tx = await this.queries.transaction(notFoundUnlessUuid(transactionId, "transaction"));
    if (tx === undefined) throw new HttpProblem(404, "NOT_FOUND", `transaction ${transactionId} not found`);
    return transactionResponse(tx);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<TransactionResponse> {
    const tx = await this.queries.transactionByProviderExternalId(providerId, externalTransactionId);
    if (tx === undefined) {
      throw new HttpProblem(404, "NOT_FOUND", `transaction ${providerId}/${externalTransactionId} not found`);
    }
    return transactionResponse(tx);
  }
}
