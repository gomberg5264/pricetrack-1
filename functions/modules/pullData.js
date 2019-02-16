const assert = require('assert')
const fetch = require('node-fetch')
const functions = require('firebase-functions')
const {
  asiaRegion,
  db,
  pullProductDataFromUrl,
  normalizeUrl,
  documentIdFromHashOrUrl,
  collection,
  validateToken,
  getConfig,
  urlFor,
  resError
} = require('../utils')
const FieldValue = require('firebase-admin').firestore.FieldValue

const {
  text: {
    ERR_MISSING_URL,
    ERR_TOKEN_INVALID,
    ERR_CANNOT_FETCH_DATA
  }
} = require('../utils/constants')

const ADMIN_TOKEN = getConfig('admin_token')

module.exports = functions
  .region(asiaRegion)
  .runWith({
    memory: '512MB',
    timeoutSeconds: 60
  })
  .https
  .onRequest(async (req, res) => {
    let url = String(req.query.url || '')
    url = normalizeUrl(url)

    const token = String(req.query.token || '')
    if (!validateToken(token)) {
      console.error(`[pullData] invalid token: ${token}`)
      return resError(res, ERR_TOKEN_INVALID, 403)
    }

    if (!url) return resError(res, ERR_MISSING_URL)

    const urlHash = documentIdFromHashOrUrl(url)
    console.log(`[pullData] START: url=${url} (hash=${urlHash})`)

    let snapshot = null
    let jsonData = null

    try {
      snapshot = await db.collection(collection.URLS).doc(urlHash).get()
      assert(snapshot != null)
    } catch (err) {
      console.error(err)
      return resError(res, err.message, 500)
    }

    if (!snapshot.exists) {
      console.error(`Trigger not found URL ${url}, urlHash=${urlHash}`)
      return resError(res, `Trigger not found URL ${url}`, 500)
    }

    let raw_count = snapshot.get('raw_count') || 0
    let latest_price = snapshot.get('latest_price') || 0
    let num_price_change = snapshot.get('num_price_change') || 0
    let num_price_change_up = snapshot.get('num_price_change_up') || 0
    let num_price_change_down = snapshot.get('num_price_change_down') || 0

    try {
      jsonData = await pullProductDataFromUrl(url)
      assert(jsonData != null)
    } catch (err) {
      console.error(err)
      return resError(res, err.message, 500)
    }

    // Skip if error
    if (!jsonData || !jsonData['price']) return resError(res, ERR_CANNOT_FETCH_DATA)

    console.info(`[pullData] RESULT: ${JSON.stringify(jsonData)}`)
    jsonData['datetime'] = FieldValue.serverTimestamp()
    let new_price = jsonData['price']
    let inventory_status = 'inventory_status' in jsonData ? jsonData['inventory_status'] : ''

    let update_jsonData = {
      last_pull_at: jsonData['datetime'],
      raw_count: raw_count + 1,
      latest_price: new_price,
      inventory_status,
    }

    // Update statistic
    if (latest_price && new_price - latest_price != 0) {
      // Price change in VND and percentage
      let price_change = new_price - latest_price
      let price_change_percent = (latest_price > 0) ? (100 * price_change / latest_price) : 100

      // Is price up or down?
      let is_price_up = price_change > 0

      // How many time the price change?
      num_price_change = price_change_percent > 0 ? num_price_change + 1 : num_price_change
      num_price_change_up = price_change_percent > 0 ? num_price_change_up + 1 : num_price_change_up
      num_price_change_down = price_change_percent < 0 ? num_price_change_down + 1 : num_price_change_down

      update_jsonData = Object.assign(update_jsonData, {
        // Price change
        latest_price: new_price,
        price_change,
        price_change_percent,
        price_change_at: new Date(),
        is_price_up,
        num_price_change,
        num_price_change_up,
        num_price_change_down,
        is_change: true,
        is_deal: jsonData['is_deal']
      })

      jsonData = Object.assign(jsonData, { is_change: true })
    }


    // inventory_status change
    if (jsonData['inventory_status'] != snapshot.get('inventory_status')) {
      update_jsonData = Object.assign(update_jsonData, {
        is_inventory_status_change: true,
        is_change: true
      })
      jsonData = Object.assign(jsonData, { is_change: true })
    }

    // Update URL info
    db.collection(collection.URLS).doc(urlHash).set(update_jsonData, {
      merge: true
    })

    // Add raw price
    db.collection(collection.URLS).doc(urlHash).collection('raw').add(jsonData)

    // Trigger alert if is_change
    if (update_jsonData.is_change) {
      const alertTriggerUrl = urlFor('alert', {
        url: snapshot.get('url'),
        token: ADMIN_TOKEN
      })
      fetch(alertTriggerUrl)
      console.info(`Trigger alert ${alertTriggerUrl}`)
    }

    // Done
    res.json({
      msg: 'ok',
      alert_triggered: !!jsonData.is_change,
      jsonData
    })
  })