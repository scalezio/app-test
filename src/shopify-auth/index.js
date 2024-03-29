const nonce = require('nonce')();
const crypto = require('crypto');
const cookie = require('cookie');
const querystring = require('querystring');
const request = require('request-promise');
const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('../db/database-module');
const Config = require('../../config').getDetails();

const router = express.Router();

router.get('/', (req, res) => {
  const { apiKey, scopes, appAddress } = Config;
  console.log(Config);
  const { shop } = req.query;
  if (shop) {
    const state = nonce();
    const redirectUri = `${appAddress}/shopify/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${apiKey}&scope=${scopes}&state=${state}&redirect_uri=${redirectUri}`;

    res.cookie('state', state);
    res.redirect(installUrl);
  } else {
    res
      .status(400)
      .send(
        'Missing shop parameter. Please add ?shop=your-development-shop.myshopify.com to your request',
      );
  }
});

router.get('/callback', (req, res) => {
  const { apiKey, apiSecret, appAddress } = Config;
  const { shop, hmac, code, state } = req.query;
  const stateCookie = cookie.parse(req.headers.cookie).state;
  console.log('$ callback');
  res.cookie('shop', shop);
  if (state !== stateCookie) {
    return res.status(403).send('Request origin cannot be verified');
  }

  if (shop && hmac && code) {
    // DONE: Validate request is from Shopify
    const map = Object.assign({}, req.query);
    delete map.signature;
    delete map.hmac;
    const message = querystring.stringify(map);
    const providedHmac = Buffer.from(hmac, 'utf-8');
    const generatedHash = Buffer.from(
      crypto
        .createHmac('sha256', apiSecret)
        .update(message)
        .digest('hex'),
      'utf-8',
    );
    let hashEquals = false;

    try {
      hashEquals = crypto.timingSafeEqual(generatedHash, providedHmac);
    } catch (e) {
      hashEquals = false;
    }

    if (!hashEquals) {
      return res.status(400).send('HMAC validation failed');
    }

    // DONE: Exchange temporary code for a permanent access token
    const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
    const accessTokenPayload = {
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    };
    request
      .post(accessTokenRequestUrl, { json: accessTokenPayload })
      .then(async (accessTokenResponse) => {
        const accessToken = accessTokenResponse.access_token;
        const accessTokenCookie = cookie.parse(req.headers.cookie).access_token;
        if (!accessTokenCookie) {
          res.cookie('access_token', accessToken);
        }

        if (!(await db.checkIfMerchantExists(shop))) {
          const { _id: merchantId } = await db.addMerchant(shop, accessToken);
          request
            .post({
              url: `https://${shop}/admin/script_tags.json`,
              headers: {
                'X-Shopify-Access-Token': accessToken,
              },
              json: {
                script_tag: {
                  event: 'onload',
                  src: `${appAddress}/chat/client/main.js?id=${merchantId}`,
                },
              },
            })
            .then(() => {
              console.log('added file');
              res.status(200).send('Installed!');
            });
        } else {
          res.status(200).send('Already Installed');
        }
      })
      .catch((error) => {
        res.status(error.statusCode).send(error.error.error_description);
      });
  } else {
    res.status(400).send('Required parameters missing');
  }
});

const callToApi = async (method, path, token, json) =>
  request[method]({
    url: `https://some-outlets.myshopify.com${path}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-type': 'application/json',
    },
    json,
  }).then((resp) => {
    try {
      return JSON.parse(resp);
    } catch (e) {
      console.log('put');
    }
  });
// );

router.get('/allThemes', async (req, res) => {
  const token = cookie.parse(req.headers.cookie).access_token;
  const { themes } = await callToApi('get', '/admin/themes.json', token);
  const mainTheme = themes.find(({ role }) => role === 'main');
  const { assets } = await callToApi(
    'get',
    `/admin/themes/${mainTheme.id}/assets.json`,
    token,
  );
  const productAsset = assets.find(
    (ass) => ass.key === 'sections/product-template.liquid',
  );
  const file = await callToApi(
    'get',
    `/admin/themes/${mainTheme.id}/assets.json?asset[key]=${
      productAsset.key
    }&theme_id=${productAsset.theme_id}`,
    token,
  );
  // console.log(file);
  const snippetContent = fs
    .readFileSync('/home/nimrod/Projects/Yaron/Scalez/app-test/src/chat/client/theme-assets/customer_id.liquid')
    .toString();
  console.log(snippetContent);

  const uploadFile = await callToApi(
    'put',
    `/admin/themes/${mainTheme.id}/assets.json`,
    token,
    {
      asset: {
        key: 'snippets/customer-id.liquid',
        value: snippetContent,
      },
    },
  );
  // const validation = await callToApi(
  //   'put',
  //   `/admin/themes/${mainTheme.id}/assets.json`,
  //   token,
  //   {
  //     asset: {
  //       key: productAsset.key,
  //       value: "{% include 'customer-id' %}" + file.asset.value, //eslint-disable-line
  //     },
  //   },
  // );
  res.send('done');
});

module.exports = router;
