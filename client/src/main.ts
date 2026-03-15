import { createApp } from "vue";

import { ElIcon } from "element-plus";
import "element-plus/es/components/icon/style/css";

import App from "./App.vue";
import "./global.css";

import { installViewportCssVars } from "./lib/viewport";

installViewportCssVars();

const app = createApp(App);
app.component("ElIcon", ElIcon);
app.mount("#app");
