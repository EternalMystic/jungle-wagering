import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth.guard";
import { enrichLogContext } from "../../../infrastructure/logging/log-context";
import type { OpenWalletCommand, WalletView } from "../../../application/open-wallet";
import type { Wallet } from "../../../domain/wallet";
import { HttpProblem } from "../http-problem";
import { type WalletResponse, correlationIdFrom, parseOpenWallet, uuid, walletResponse } from "./dto";
import { ID_GENERATOR, OPEN_WALLET, WAGERING_QUERIES } from "./tokens";

// Portas estruturais locais: o metadata dos decorators vira `Object` (ver app.module.ts).
interface OpenWalletPort {
  execute(command: OpenWalletCommand): Promise<WalletView>;
}
interface WalletQueriesPort {
  wallet(walletId: string): Promise<Wallet | undefined>;
}
interface IdPort {
  next(): string;
}

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWalletPort,
    @Inject(WAGERING_QUERIES) private readonly queries: WalletQueriesPort,
    @Inject(ID_GENERATOR) private readonly ids: IdPort,
  ) {}

  /** 201; player+moeda duplicado → 409 WALLET_ALREADY_EXISTS (D5). */
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers("x-correlation-id") correlation: unknown): Promise<WalletResponse> {
    const command = parseOpenWallet(body, correlationIdFrom(correlation, () => this.ids.next()));
    const wallet = await this.openWallet.execute(command);
    enrichLogContext({ walletId: wallet.id });
    return walletResponse(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string): Promise<WalletResponse> {
    const wallet = await this.queries.wallet(notFoundUnlessUuid(walletId, "wallet"));
    if (wallet === undefined) throw new HttpProblem(404, "NOT_FOUND", `wallet ${walletId} not found`);
    return walletResponse(wallet);
  }
}

/** Id mal formado não pode existir: 404, como qualquer recurso inexistente (D5). */
export function notFoundUnlessUuid(value: string, what: string): string {
  try {
    return uuid(value, what);
  } catch {
    throw new HttpProblem(404, "NOT_FOUND", `${what} ${value} not found`);
  }
}
