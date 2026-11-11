Component({
  properties: { active: String },
  data: {
    tabs: [
      { id: 'menu', icon: 'utensils', text: '点菜' },
      { id: 'today', icon: 'calendar', text: '今日菜单' },
      { id: 'pantry', icon: 'basket', text: '食材' },
      { id: 'family', icon: 'home', text: '小家' },
    ],
  },
  methods: {
    go(e) {
      const id = e.currentTarget.dataset.id;
      if (id !== this.data.active) require('../../lib/navigation').go(id);
    },
  },
});
