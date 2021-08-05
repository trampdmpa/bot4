/* eslint-disable @typescript-eslint/no-unused-vars */
import { Ticker } from 'ccxt';
import { ExchangeId } from '../../constants/exchanges.constants';
import { Account } from '../../entities/account.entities';
import { Trade } from '../../entities/trade.entities';
import { SpotExchangeService } from './base/spot.exchange.service';

export class BinanceSpotExchangeService extends SpotExchangeService {
  constructor() {
    super(ExchangeId.Binance);
  }
  handleReverseOrder(
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<void> {
    throw new Error('Method not implemented.');
  }
  handleOverflow(
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
}
