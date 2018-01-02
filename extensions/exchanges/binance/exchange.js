const ccxt = require('ccxt')
  , path = require('path')
  , colors = require('colors')
  , moment = require('moment')
  , _ = require('lodash')
  , n = require('numbro')

module.exports = function container (get, set, clear) {
  var c = get('conf')

  var public_client, authed_client

  function publicClient () {
    if (!public_client) public_client = new ccxt.binance({ 'apiKey': '', 'secret': '' })
    return public_client
  }

  function authedClient () {
    if (!authed_client) {
      if (!c.binance || !c.binance.key || c.binance.key === 'YOUR-API-KEY') {
        throw new Error('please configure your Binance credentials in ' + path.resolve(__dirname, 'conf.js'))
      }
      authed_client = new ccxt.binance({ 'apiKey': c.binance.key, 'secret': c.binance.secret })
    }
    return authed_client
  }

  function joinProduct(product_id) {
    return product_id.split('-')[0] + '/' + product_id.split('-')[1]
  }

  function retry (method, args, err) {
    if (method !== 'getTrades') {
      console.error(('\nBinance API is down! unable to call ' + method + ', retrying in 20s').red)
      if (err) console.error(err)
      console.error(args.slice(0, -1))
    }
    setTimeout(function () {
      exchange[method].apply(exchange, args)
    }, 20000)
  }

  var orders = {}

  var exchange = {
    name: 'binance',
    historyScan: 'forward',
    makerFee: 0.1,
    takerFee: 0.1,

    getProducts: function () {
      return require('./products.json')
    },

    getTrades: function (opts, cb) {
      var func_args = [].slice.call(arguments)

      var args = {};
      if (opts.from) {
        args.startTime = opts.from
      }
      if (opts.to) {
        args.endTime = opts.to
      }
      if (args.startTime && !args.endTime) {
        // add 12 hours
        args.endTime = args.startTime + 43200000
      }
      else if (args.endTime && !args.startTime) {
        // subtract 12 hours
        args.startTime = args.endTime - 43200000
      }

      var client = publicClient()
      client.fetchTrades(joinProduct(opts.product_id), '','', args).then(result => {
        var trades = result.map(function (trade) {
          return {
            trade_id: trade.id,
            time: trade.timestamp,
            size: parseFloat(trade.amount),
            price: parseFloat(trade.price),
            side: trade.side
          }
        })
        cb(null, trades)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('getTrades', func_args)
      })
    },

    getBalance: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      client.fetchBalance().then(result => {
        var balance = {asset: 0, currency: 0}
        Object.keys(result).forEach(function (key) {
          if (key === opts.currency) {
            balance.currency = result[key].free + result[key].used
            balance.currency_hold = result[key].used
          }
          if (key === opts.asset) {
            balance.asset = result[key].free + result[key].used
            balance.asset_hold = result[key].used
          }
        })
        cb(null, balance)
      })
        .catch(function (error) {
          console.error('An error occurred', error)
          return retry('getBalance', func_args)
        })
    },

    getQuote: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = publicClient()
      client.fetchTicker(joinProduct(opts.product_id)).then(result => {
        cb(null, { bid: result.bid, ask: result.ask })
      })
        .catch(function (error) {
          console.error('An error occurred', error)
          return retry('getQuote', func_args)
        })
    },

    cancelOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      client.cancelOrder(opts.order_id, joinProduct(opts.product_id)).then(function (body) {
        if (body && (body.message === 'Order already done' || body.message === 'order not found')) return cb()
        cb(null)
      },function(err){
        if (err) return retry('cancelOrder', func_args, err)
        cb()
      })
    },

    buy: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      if (typeof opts.post_only === 'undefined') {
        opts.post_only = true
      }
      opts.type = 'limit'
      var args = {}
      if (opts.order_type === 'taker') {
        delete opts.price
        delete opts.post_only
        opts.type = 'market'
      } else {
        args.timeInForce = 'GTC'
      }
      opts.side = 'buy'
      delete opts.order_type
      var order = {}
      client.createOrder(joinProduct(opts.product_id), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args).then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {
            status: 'rejected',
            reject_reason: 'balance'
          }
          return cb(null, order)
        }
        order = {
          id: result ? result.id : null,
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }
        orders['~' + result.id] = order
        cb(null, order)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('buy', func_args)
      })
    },

    sell: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      if (typeof opts.post_only === 'undefined') {
        opts.post_only = true
      }
      opts.type = 'limit'
      var args = {}
      if (opts.order_type === 'taker') {
        delete opts.price
        delete opts.post_only
        opts.type = 'market'
      } else {
        args.timeInForce = 'GTC'
      }
      opts.side = 'sell'
      delete opts.order_type
      var order = {}
      client.createOrder(joinProduct(opts.product_id), opts.type, opts.side, this.roundToNearest(opts.size, opts), opts.price, args).then(result => {
        if (result && result.message === 'Insufficient funds') {
          order = {
            status: 'rejected',
            reject_reason: 'balance'
          }
          return cb(null, order)
        }
        order = {
          id: result ? result.id : null,
          status: 'open',
          price: opts.price,
          size: this.roundToNearest(opts.size, opts),
          post_only: !!opts.post_only,
          created_at: new Date().getTime(),
          filled_size: '0',
          ordertype: opts.order_type
        }
        orders['~' + result.id] = order
        cb(null, order)
      }).catch(function (error) {
        console.error('An error occurred', error)
        return retry('sell', func_args)
      })
    },

    roundToNearest: function(numToRound, opts) {
      var numToRoundTo = _.find(this.getProducts(), { 'asset': opts.product_id.split('-')[0], 'currency': opts.product_id.split('-')[1] }).min_size
      numToRoundTo = 1 / (numToRoundTo)

      return Math.floor(numToRound * numToRoundTo) / numToRoundTo
    },

    getOrder: function (opts, cb) {
      var func_args = [].slice.call(arguments)
      var client = authedClient()
      var order = orders['~' + opts.order_id]
      client.fetchOrder(opts.order_id, joinProduct(opts.product_id)).then(function (body) {
        if (body.status !== 'open' && body.status !== 'canceled') {
          order.status = 'done'
          order.done_at = new Date().getTime()
          order.filled_size = parseFloat(body.amount) - parseFloat(body.remaining)
          return cb(null, order)
        }
        cb(null, order)
      }, function(err) {
        return retry('getOrder', func_args, err)
      })
    },

    getCursor: function (trade) {
      return (trade.time || trade)
    }
  }
  return exchange
}