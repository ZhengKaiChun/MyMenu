const config = require('../config/index'),
  session = require('./session');
const imageCache = {};
const pendingImages = {};
const isPreview = () => config.mode === 'preview';
const preview = () => require('../preview/index');
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
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
  if (isPreview()) return preview().request(path, options, session.token);
  return send(path, options);
}
async function image(id, fallback = '/assets/food-placeholder.png', shareToken) {
  if (!id) return fallback;
  if (isPreview()) return preview().image(id, fallback);
  const cacheKey = session.token + ':' + (shareToken || '') + ':' + id;
  if (imageCache[cacheKey] && imageCache[cacheKey].expires > Date.now())
    return imageCache[cacheKey].path;
  if (pendingImages[cacheKey]) return pendingImages[cacheKey];
  const job = (async () => {
    try {
      const out = await request('/media/' + id + '/url', {
        method: 'POST',
        body: shareToken ? { shareToken } : {},
      });
      // Native image components can reject signed network URLs. Download through
      // WeChat's configured download domain and render the local temporary file.
      const path = await new Promise((resolve, reject) =>
        wx.downloadFile({
          url: out.url,
          timeout: 12000,
          success(result) {
            if (result.statusCode === 200 && result.tempFilePath) resolve(result.tempFilePath);
            else reject(new Error('IMAGE_DOWNLOAD_' + result.statusCode));
          },
          fail: reject,
        }),
      );
      imageCache[cacheKey] = { path, expires: Date.now() + 240000 };
      return path;
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn)
        console.warn('Dish image unavailable', error.code || error.errMsg || error.message);
      return fallback;
    }
  })();
  pendingImages[cacheKey] = job;
  try {
    return await job;
  } finally {
    delete pendingImages[cacheKey];
  }
}
async function upload(path, options = {}) {
  // Bundled artwork is read-only. Formal uploads use a short-lived writable copy.
  if (!isPreview() && /^\/?assets\/(avatars\/pig-[0-7]\.png|food-[0-3]\.jpg)$/.test(path)) {
    const fs = wx.getFileSystemManager(),
      dest =
        wx.env.USER_DATA_PATH + '/legacy-art-' + uuid() + (path.endsWith('.jpg') ? '.jpg' : '.png');
    await new Promise((resolve, reject) =>
      fs.copyFile({
        srcPath: '/' + path.replace(/^\//, ''),
        destPath: dest,
        success: resolve,
        fail: reject,
      }),
    );
    try {
      return await upload(dest, { ...options, crop: false });
    } finally {
      fs.unlink({ filePath: dest, success() {}, fail() {} });
    }
  }

  if (options.crop !== false && wx.cropImage) {
    const out = await new Promise((resolve, reject) =>
      wx.cropImage({ src: path, cropScale: '1:1', success: resolve, fail: reject }),
    );
    path = out.tempFilePath;
  }

  if (isPreview()) return preview().upload(path);
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
module.exports = { request, image, upload, uuid, isPreview };
