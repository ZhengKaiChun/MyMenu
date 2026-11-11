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
        i.src = src;
      });
    ctx.drawImage(await load('/assets/recipe-share.png'), 0, 0, 500, 400);
    const rows = dishes.slice(0, 3),
      w = 86,
      gap = 13,
      left = (500 - rows.length * w - (rows.length - 1) * gap) / 2;
    for (let i = 0; i < rows.length; i++) {
      try {
        const info = await new Promise((r, j) =>
          wx.getImageInfo({ src: rows[i].cover, success: r, fail: j }),
        );
        const img = await load(info.path),
          x = left + i * (w + gap),
          size = Math.min(img.width, img.height);
        ctx.fillStyle = '#fffaf0';
        ctx.fillRect(x - 4, 154, w + 8, 94);
        ctx.drawImage(
          img,
          (img.width - size) / 2,
          (img.height - size) / 2,
          size,
          size,
          x,
          158,
          w,
          w,
        );
        ctx.strokeStyle = '#c3a17b';
        ctx.strokeRect(x - 4, 154, w + 8, 94);
      } catch {
        /* Keep the paper visible if a dish image cannot load. */
      }
    }
    ctx.fillStyle = '#eddbbb';
    ctx.strokeStyle = '#a98660';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(44, 244);
    ctx.lineTo(250, 319);
    ctx.lineTo(456, 244);
    ctx.lineTo(456, 362);
    ctx.lineTo(44, 362);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#bd7d60';
    ctx.beginPath();
    ctx.arc(250, 310, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5dec1';
    ctx.textAlign = 'center';
    ctx.font = '24px sans-serif';
    ctx.fillText('♥', 250, 319);
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
