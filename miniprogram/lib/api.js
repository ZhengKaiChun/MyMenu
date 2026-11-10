const config = require('../config/index'),
  session = require('./session');
const imageCache = {};
function uuid() {
  return (
    'op-' +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2) +
    '-' +
    Math.random().toString(36).slice(2)
  );
}
function send(path, options) {
  return new Promise((resolve, reject) =>
    wx.request({
      url: config.apiBase + path,
      method: options.method || 'GET',
      data: options.body,
      timeout: 12000,
      header: {
        'content-type': 'application/json',
        ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else {
          const e = new Error(
            res.data && res.data.error ? res.data.error.message : '操作失败，请稍后重试',
          );
          e.status = res.statusCode;
          e.code = res.data && res.data.error && res.data.error.code;
          reject(e);
        }
      },
      fail() {
        reject(new Error('连接不上小厨房，请稍后重试'));
      },
    }),
  );
}
async function request(path, options = {}) {
  if (options.method && options.method !== 'GET' && !options.key) options.key = uuid();
  return send(path, options);
}
async function image(id, fallback = '/assets/food-placeholder.png', shareToken) {
  if (!id) return fallback;
  if (imageCache[id] && imageCache[id].expires > Date.now()) return imageCache[id].url;
  try {
    let out = await request('/media/' + id + '/url', {
      method: 'POST',
      body: shareToken ? { shareToken } : {},
    });
    imageCache[id] = { url: out.url, expires: Date.now() + 240000 };
    return out.url;
  } catch {
    return fallback;
  }
}
async function upload(path) {
  return new Promise((resolve, reject) =>
    wx.uploadFile({
      url: config.apiBase + '/media',
      filePath: path,
      name: 'file',
      header: { Authorization: 'Bearer ' + session.token },
      success(r) {
        try {
          const out = JSON.parse(r.data);
          r.statusCode === 200 ? resolve(out) : reject(new Error(out.error.message));
        } catch (e) {
          reject(e);
        }
      },
      fail() {
        reject(new Error('图片上传失败，已保留填写内容'));
      },
    }),
  );
}
module.exports = { request, image, upload, uuid };
