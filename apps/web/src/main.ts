import { createApp } from 'vue';
import { createPinia } from 'pinia';
// 组件样式由 unplugin-vue-components 按需注入；ElMessage 是函数式调用，需要手动引入其样式。
import 'element-plus/es/components/message/style/css';
import './style.css';
import App from './App.vue';

createApp(App).use(createPinia()).mount('#app');
