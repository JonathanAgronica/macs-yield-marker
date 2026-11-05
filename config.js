/* AgronicaWorld upload configuration. Upload stays DISABLED until both INGEST_URL and INGEST_KEY are set.
   Endpoint contract: see README.md "AgronicaWorld upload payload". */
(function (root) {
  var cfg = {
    INGEST_URL: 'https://170-64-148-102.sslip.io/api/yield/submit',
    INGEST_KEY: 'yk-88c1ea59914cee776a7e070f',   // sent as the X-Ingest-Key header
    INGEST_URL_PLACEHOLDER: 'https://170-64-148-102.sslip.io/api/yield/submit',
    AI_COUNT_URL: 'https://170-64-148-102.sslip.io/api/yield/ai-count',   // server-side AI nut count on AgronicaWorld (POST multipart: image + meta). Blank = AI button disabled. Never put API keys here: the OpenAI key lives on the server.
    FARM: '',                // optional default farm name
    APP_VERSION: 'v4'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = cfg; else root.YM_CONFIG = cfg;
})(typeof self !== 'undefined' ? self : this);
