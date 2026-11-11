module.exports = async function (page, dishes) {
  try {
    await new Promise((r) => setTimeout(r, 100));
    const canvas = await new Promise((r) =>
      wx
        .createSelectorQuery()
        .in(page)
        .select('#shareCoverCanvas')
        .fields({ node: true, size: true })
        .exec((x) => r(x[0]?.node)),
    );
    if (!canvas) return '/assets/recipe-share.png';
    canvas.width = 500;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const load = (src) =>
      new Promise((r, j) => {
        const i = canvas.createImage();
        i.onload = () => r(i);
        i.onerror = j;
        i.src = src.startsWith('assets/') ? '/' + src : src;
      });
    ctx.drawImage(await load('/assets/recipe-share.png'), 0, 0, 500, 400);
    // Only one dish peeks out; offset paper layers hint at the rest of the parcel.
    const dish = dishes[0];
    if (dish) {
      const x = 307,
        y = 189,
        w = 120;
      ctx.fillStyle = '#f2e3c7';
      ctx.strokeStyle = '#c8ad83';
      ctx.lineWidth = 1;
      ctx.save();
      ctx.translate(x + w / 2, y + w / 2);
      ctx.rotate(0.08);
      ctx.fillRect(-w / 2 - 2, -w / 2 - 9, w + 8, w + 18);
      ctx.strokeRect(-w / 2 - 2, -w / 2 - 9, w + 8, w + 18);
      ctx.restore();
      ctx.fillStyle = '#fffdf6';
      ctx.fillRect(x - 6, y - 7, w + 12, w + 25);
      ctx.strokeRect(x - 6, y - 7, w + 12, w + 25);
      try {
        const info = await new Promise((resolve, reject) =>
          wx.getImageInfo({ src: dish.cover, success: resolve, fail: reject }),
        );
        const img = await load(info.path),
          size = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, x, y, w, w);
      } catch {
        ctx.drawImage(await load('/assets/food-placeholder.png'), x, y, w, w);
      }
      ctx.fillStyle = '#efe0c0';
      ctx.beginPath();
      ctx.moveTo(x + w - 17, y - 7);
      ctx.lineTo(x + w + 6, y + 16);
      ctx.lineTo(x + w + 6, y - 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#98704e';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        dishes.length > 1 ? '还有' + (dishes.length - 1) + '道，藏在信里' : '这道拿手菜，送给你',
        x + w / 2,
        y + w + 12,
      );
    }
    return await new Promise((r, j) =>
      wx.canvasToTempFilePath(
        {
          canvas,
          width: 500,
          height: 400,
          destWidth: 500,
          destHeight: 400,
          fileType: 'png',
          success: (x) => r(x.tempFilePath),
          fail: j,
        },
        page,
      ),
    );
  } catch {
    return '/assets/recipe-share.png';
  }
};
