const asyncAuto = require('async/auto');
const asyncMap = require('async/map');
const {formatTokens} = require('ln-sync');
const {getChainTransactions} = require('ln-accounting');
const {getNetwork} = require('ln-sync');
const moment = require('moment');
const {returnResult} = require('asyncjs-util');

const feesForSegment = require('./fees_for_segment');

const daysBetween = (a, b) => moment(a).diff(b, 'days') || 1;
const daysPerWeek = 7;
const defaultDays = 60;
const isDate = n => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(n);
const flatten = arr => [].concat(...arr);
const {floor} = Math;
const hoursPerDay = 24;
const {isArray} = Array;
const minChartDays = 4;
const maxChartDays = 90;
const {now} = Date;
const parseDate = n => Date.parse(n);

/** Get Blockchain fees paid

  {
    [days]: <Chain Fees Paid Over Days Count Number>
    [end_date]: <End Date YYYY-MM-DD String>
    is_monochrome: <Omit Colors Bool>
    lnds: [<Authenticated LND API Object>]
    request: <Request Function>
    [start_date]: <Start Date YYYY-MM-DD String>
  }

  @returns via cbk or Promise
  {
    data: [<Chain Fee Tokens Number>]
    description: <Chart Description String>
    title: <Chart Title String>
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!isArray(args.lnds) || !args.lnds.length) {
          return cbk([400, 'ExpectedLndToGetChainFeesChart']);
        }

        if (!args.request) {
          return cbk([400, 'ExpectedRequestFunctionToGetChainFees']);
        }

        // Exit early when there is no end date and no start date
        if (!args.end_date && !args.start_date) {
          return cbk();
        }

        if (!!args.days) {
          return cbk([400, 'ExpectedEitherDaysOrDatesToGetChainFeesChart']);
        }

        if (!!args.end_date && !args.start_date) {
          return cbk([400, 'ExpectedStartDateToRangeToEndDate']);
        }

        if (!moment(args.start_date).isValid()) {
          return cbk([400, 'ExpectedValidEndDateForReceivedChartEndDate']);
        }

        if (parseDate(args.start_date) > now()) {
          return cbk([400, 'ExpectedPastStartDateToGetChainFeesChart']);
        }

        // Exit early when there is no end date
        if (!args.end_date) {
          return cbk();
        }

        if (args.start_date >= args.end_date) {
          return cbk([400, 'ExpectedStartDateBeforeEndDateToGetChainFeesChart']);
        }

        if (!isDate(args.end_date)) {
          return cbk([400, 'ExpectedValidDateFormatToForChartEndDate']);
        }

        if (!moment(args.end_date).isValid()) {
          return cbk([400, 'ExpectedValidEndDateForReceivedChartEndDate']);
        }

        if (parseDate(args.end_date) > now()) {
          return cbk([400, 'ExpectedPastEndDateToGetChainFeesChart']);
        }

        if (!isDate(args.start_date)) {
          return cbk([400, 'ExpectedValidDateFormatToForChartStartDate']);
        }

        return cbk();
      },

      // End date for chain transactions
      end: ['validate', ({}, cbk) => {
        if (!args.end_date) {
          return cbk();
        }

        return cbk(null, moment(args.end_date));
      }],

      // Start date for received payments
      start: ['validate', ({}, cbk) => {
        if (!!args.start_date) {
          return cbk(null, moment(args.start_date));
        }

        return cbk(null, moment().subtract(args.days || defaultDays, 'days'));
      }],

      // Get chain transactions
      getTransactions: ['start', ({start}, cbk) => {
        return asyncMap(args.lnds, (lnd, cbk) => {
          return getNetwork({lnd}, (err, res) => {
            if (!!err) {
              return cbk(err);
            }

            return getChainTransactions({
              lnd,
              after: start.toISOString(),
              network: res.network,
              request: args.request,
            },
            cbk);
          });
        },
        (err, res) => {
          if (!!err) {
            return cbk(err);
          }

          return cbk(null, flatten(res.map(({transactions}) => transactions)));
        });
      }],

      // Segment measure
      measure: ['validate', ({}, cbk) => {
        const days = (!!args.days || !!args.start_date) ? (args.days || daysBetween(args.end_date, args.start_date)) : defaultDays;

        if (days > maxChartDays) {
          return cbk(null, 'week');
        } else if (days < minChartDays) {
          return cbk(null, 'hour');
        } else {
          return cbk(null, 'day');
        }
      }],

      // Total number of segments
      segments: ['measure', ({measure}, cbk) => {
        const days = (!!args.days || !!args.start_date) ? (args.days || daysBetween(args.end_date, args.start_date)) : defaultDays;
        
        switch (measure) {
        case 'hour':
          return cbk(null, hoursPerDay * days);

        case 'week':
          return cbk(null, floor(days / daysPerWeek));

        default:
          return cbk(null, days);
        }
      }],

      // Filter the transactions by date
      transactions: [
        'end',
        'getTransactions',
        'start',
        ({end, getTransactions, start}, cbk) =>
      {
        const transactions = getTransactions.filter(tx => {
          if (!tx.is_confirmed) {
            return false;
          }

          if (!args.end_date) {
            return !!tx.fee && tx.created_at > start.toISOString();
          }

          return !!tx.fee && tx.created_at > start.toISOString() && tx.created_at <= end.toISOString();

        });

        return cbk(null, transactions);
      }],

      // Total paid
      total: ['transactions', ({transactions}, cbk) => {
        const paid = transactions.reduce((sum, {fee}) => sum + fee, Number());

        return cbk(null, paid);
      }],

      // Payments activity aggregated
      sum: [
        'end',
        'measure',
        'segments',
        'transactions',
        ({end, measure, segments, transactions}, cbk) =>
      {
        return cbk(null, feesForSegment({
          end,
          measure,
          segments,
          forwards: transactions,
        }));
      }],

      // Summary description of the chain fees paid
      description: [
        'end',
        'measure',
        'start',
        'sum',
        'total',
        async ({end, measure, start, sum, total}) =>
      {
        const duration = `Chain fees paid in ${sum.fees.length} ${measure}s`;
        const since = `since ${start.calendar().toLowerCase()}`;
        const to = !!end ? ` to ${end.calendar().toLowerCase()}` : '';

        const {display} = formatTokens({
          is_monochrome: args.is_monochrome,
          tokens: total,
        });

        return `${duration} ${since}${to}. Total: ${display}`;
      }],

      // Fees paid
      data: ['description', 'sum', ({description, sum}, cbk) => {
        const data = sum.fees;
        const title = 'Chain fees paid';

        return cbk(null, {data, description, title});
      }],
    },
    returnResult({reject, resolve, of: 'data'}, cbk));
  });
};
