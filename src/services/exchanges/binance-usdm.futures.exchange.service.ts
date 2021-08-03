import { Exchange, Ticker } from 'ccxt';
import { ExchangeId } from '../../constants/exchanges.constants';
import { Side } from '../../constants/trading.constants';
import { Account } from '../../entities/account.entities';
import { Trade } from '../../entities/trade.entities';
import {
  BalancesFetchError,
  PositionsFetchError
} from '../../errors/exchange.errors';
import {
  NoOpenPositionError,
  OpenPositionError
} from '../../errors/trading.errors';
import {
  IBinanceFuturesUSDBalance,
  IBinanceFuturesUSDPosition
} from '../../interfaces/exchanges/binance.exchange.interfaces';
import { IBalance } from '../../interfaces/exchanges/common.exchange.interfaces';
import { IOrderOptions } from '../../interfaces/trading.interfaces';
import {
  POSITIONS_READ_ERROR,
  POSITIONS_READ_SUCCESS,
  NO_CURRENT_POSITION,
  POSITION_READ_SUCCESS,
  BALANCES_READ_ERROR,
  BALANCES_READ_SUCCESS
} from '../../messages/exchanges.messages';
import {
  OPEN_TRADE_ERROR_MAX_SIZE,
  REVERSING_TRADE,
  TRADE_OVERFLOW
} from '../../messages/trading.messages';
import { getAccountId } from '../../utils/account.utils';
import { formatBinanceFuturesSymbol } from '../../utils/exchanges/binance.exchange.utils';
import {
  getRelativeTradeSize,
  getTokensAmount,
  getTokensPrice
} from '../../utils/exchanges/common.exchange.utils';
import { getTradeSide, isSideDifferent } from '../../utils/trading.utils';
import { debug, error, info } from '../logger.service';
import { FuturesExchangeService } from './base/futures.exchange.service';

export class BinanceFuturesUSDMExchangeService extends FuturesExchangeService {
  constructor() {
    super(ExchangeId.BinanceFuturesUSD);
  }

  getBalances = async (
    account: Account,
    instance?: Exchange
  ): Promise<IBalance[]> => {
    const accountId = getAccountId(account);
    try {
      if (!instance) {
        instance = (await this.refreshSession(account)).exchange;
      }
      const balances = await instance.fetch_balance();
      debug(BALANCES_READ_SUCCESS(this.exchangeId, accountId));
      return balances.info.assets
        .filter((b: IBinanceFuturesUSDBalance) => Number(b.availableBalance))
        .map((b: IBinanceFuturesUSDBalance) => ({
          coin: b.asset,
          free: b.availableBalance,
          total: b.walletBalance
        }));
    } catch (err) {
      error(BALANCES_READ_ERROR(this.exchangeId, accountId), err);
      throw new BalancesFetchError(
        BALANCES_READ_ERROR(this.exchangeId, accountId, err.message)
      );
    }
  };

  getTickerPosition = async (
    account: Account,
    ticker: Ticker
  ): Promise<IBinanceFuturesUSDPosition> => {
    const accountId = getAccountId(account);
    const symbol = formatBinanceFuturesSymbol(ticker.symbol);
    const positions = await this.getPositions(account);
    const position = positions.filter((p) => p.symbol === symbol).pop();
    if (!position) {
      error(NO_CURRENT_POSITION(accountId, this.exchangeId, symbol));
      throw new NoOpenPositionError(
        NO_CURRENT_POSITION(accountId, this.exchangeId, symbol)
      );
    } else {
      debug(
        POSITION_READ_SUCCESS(accountId, this.exchangeId, symbol, position)
      );
    }
    return position;
  };

  getTickerPositionSize = async (
    account: Account,
    ticker: Ticker
  ): Promise<number> => {
    const position = await this.getTickerPosition(account, ticker);
    return Number(position.notional);
  };

  getPositions = async (
    account: Account
  ): Promise<IBinanceFuturesUSDPosition[]> => {
    const accountId = getAccountId(account);
    try {
      const positions = await this.sessions
        .get(accountId)
        .exchange.fetchPositions();
      const filtered = positions.filter((p: IBinanceFuturesUSDPosition) =>
        Number(p.positionAmt)
      );
      debug(POSITIONS_READ_SUCCESS(accountId, this.exchangeId, filtered));
      return filtered;
    } catch (err) {
      error(POSITIONS_READ_ERROR(accountId, this.exchangeId), err);
      throw new PositionsFetchError(
        POSITIONS_READ_ERROR(accountId, this.exchangeId, err.message)
      );
    }
  };

  getCloseOrderOptions = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<IOrderOptions> => {
    const { size } = trade;
    const { symbol, info } = ticker;
    const { lastPrice } = info;
    const position = await this.getTickerPosition(account, ticker);
    const current = Number(position.positionAmt);
    const price = this.getOrderCost(ticker, Math.abs(current));
    return {
      size: size.includes('%')
        ? getRelativeTradeSize(ticker, current, size) // handle percentage
        : Number(size) > price // if closing size > current
        ? current // then close all
        : getTokensAmount(symbol, lastPrice, Number(size)), // otherwise handle absolute
      side: current > 0 ? Side.Sell : Side.Buy
    };
  };

  handleReverseOrder = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<void> => {
    const { direction } = trade;
    const { symbol } = ticker;
    const accountId = getAccountId(account);
    const side = getTradeSide(direction);
    try {
      const size = await this.getTickerPositionSize(account, ticker);
      if (
        size &&
        ((size < 0 && side === Side.Buy) || (size > 0 && side === Side.Sell))
      ) {
        info(REVERSING_TRADE(this.exchangeId, accountId, symbol));
        await this.closeOrder(account, trade, ticker);
      }
    } catch (err) {
      // ignore throw
    }
  };

  // TODO extract
  handleMaxBudget = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<void> => {
    const { symbol, max, direction, size } = trade;
    const accountId = getAccountId(account);
    const side = getTradeSide(direction);
    try {
      const current = await this.getTickerPositionSize(account, ticker);
      if (Math.abs(current) + Number(size) > Number(max)) {
        error(
          OPEN_TRADE_ERROR_MAX_SIZE(
            this.exchangeId,
            accountId,
            symbol,
            side,
            max
          )
        );
        throw new OpenPositionError(
          OPEN_TRADE_ERROR_MAX_SIZE(
            this.exchangeId,
            accountId,
            symbol,
            side,
            max
          )
        );
      }
    } catch (err) {
      // silent
    }
  };

  handleOverflow = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<boolean> => {
    const { direction, size } = trade;
    const { symbol } = ticker;
    const accountId = getAccountId(account);
    try {
      // TODO refacto
      const position = await this.getTickerPosition(account, ticker);
      const { positionSide, notional } = position;
      if (
        position &&
        isSideDifferent(positionSide as Side, direction) &&
        Number(size) > Math.abs(Number(notional))
      ) {
        info(TRADE_OVERFLOW(this.exchangeId, accountId, symbol));
        await this.closeOrder(account, trade, ticker);
        return true;
      }
    } catch (err) {
      // ignore throw
    }
    return false;
  };

  getOrderCost(ticker: Ticker, size: number): number {
    const { symbol, info } = ticker;
    const { lastPrice } = info;
    return getTokensPrice(symbol, lastPrice, size);
  }
}
