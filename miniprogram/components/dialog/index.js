const service = require('../../lib/dialog');
Component({
  data: {
    active: false,
    title: '',
    content: '',
    value: '',
    editable: false,
    placeholderText: '',
    confirmText: '确定',
    cancelText: '取消',
    showCancel: true,
  },
  lifetimes: {
    attached() {
      service.mount(this);
    },
    detached() {
      if (this.data.active) this.finish(false);
      service.unmount(this);
    },
  },
  methods: {
    present(options) {
      this.modalOptions = options;
      this.setData({
        active: true,
        title: options.title || '',
        content: options.editable ? '' : options.content || '',
        value: options.editable ? options.content || '' : '',
        editable: !!options.editable,
        placeholderText: options.placeholderText || '',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        showCancel: options.showCancel !== false,
      });
    },
    input(e) {
      this.data.value = e.detail.value;
    },
    noop() {},
    confirm() {
      this.finish(true);
    },
    cancel() {
      this.finish(false);
    },
    finish(confirm) {
      const result = { confirm, cancel: !confirm, content: this.data.value };
      this.setData({ active: false });
      const o = this.modalOptions;
      this.modalOptions = null;
      if (o?.success) o.success(result);
      if (o?.complete) o.complete(result);
    },
  },
});
