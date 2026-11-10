Component({
  properties: { index: { type: Number, value: 7 }, size: { type: Number, value: 45 } },
  data: { left: 0, top: 0 },
  observers: {
    index(value) {
      this.setData({ left: -(value % 4) * 100, top: -Math.floor(value / 4) * 100 });
    },
  },
});
