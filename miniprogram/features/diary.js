const { createPage, api, familyPath, decorate } = require('../lib/page');
const dates = require('../lib/dates');
async function load() {
  const limits = dates.bounds();
  let date = this.data.date || this.query.date || limits.max;
  date = date < limits.min ? limits.min : date > limits.max ? limits.max : date;
  const year = Number(date.slice(0, 4)),
    month = Number(date.slice(5, 7));
  const first = date.slice(0, 7) + '-01',
    last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const [meal, days] = await Promise.all([
    api.request(familyPath('/history') + '?date=' + date),
    api.request(familyPath('/meal-dates') + '?from=' + first + '&to=' + last + '&history=1'),
  ]);
  const dishes = await decorate(meal.dishes.map((d) => ({ ...d, ...d.snapshot })));
  const sections = ['早餐', '午餐', '晚餐'].map((slot) => ({
    slot,
    dishes: dishes
      .filter((d) => d.slot === slot)
      .map((d) => ({ ...d, sources: require('../lib/orderers')(d.sources) })),
  }));
  const offset = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const length = Number(last.slice(-2)),
    dots = days.map((d) => d.date);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = i - offset + 1;
    if (day < 1 || day > length) return { id: 'empty-' + i, blank: true };
    const value = date.slice(0, 7) + '-' + String(day).padStart(2, '0');
    return {
      id: value,
      date: value,
      day,
      on: value === date,
      dot: dots.includes(value),
      disabled: value < limits.min || value > limits.max,
    };
  });
  const slot =
    this.data.date !== date
      ? sections.find((s) => s.dishes.length)?.slot || '早餐'
      : this.data.slot;
  this.setData({
    date,
    limits,
    year,
    month,
    cells,
    sections,
    slot,
    displayDishes: sections.find((s) => s.slot === slot)?.dishes || [],
    canPrev: date.slice(0, 7) > limits.min.slice(0, 7),
    canNext: date.slice(0, 7) < limits.max.slice(0, 7),
  });
}
module.exports = createPage({
  data: {
    date: '',
    slot: '早餐',
    cells: [],
    sections: [],
    displayDishes: [],
    weekLabels: ['一', '二', '三', '四', '五', '六', '日'],
  },
  reload: load,
  methods: {
    async selectDate(e) {
      const date = e.currentTarget.dataset.date;
      if (!date || date < this.data.limits.min || date > this.data.limits.max) return;
      this.setData({ date, slot: '' });
      await load.call(this);
      if (!this.data.slot) {
        this.setData({ slot: this.data.sections.find((s) => s.dishes.length)?.slot || '早餐' });
        this.setData({
          displayDishes: this.data.sections.find((s) => s.slot === this.data.slot).dishes,
        });
      }
    },
    async month(e) {
      const dir = Number(e.currentTarget.dataset.dir);
      if ((dir < 0 && !this.data.canPrev) || (dir > 0 && !this.data.canNext)) return;
      const target = dates.month(this.data.date.slice(0, 7) + '-01', dir);
      this.setData({ date: target, slot: '早餐' });
      await load.call(this);
    },
    meal(e) {
      const slot = e.currentTarget.dataset.slot;
      this.setData({ slot, displayDishes: this.data.sections.find((s) => s.slot === slot).dishes });
    },
  },
});
