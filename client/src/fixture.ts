// Dedicated entry for browser fixture pages, built only via
// `npm run build:web:fixture` (ADS_WEB_FIXTURE_ENTRY=1). The production
// build:web output never includes fixture code.
import { createApp } from "vue";

import { ElIcon } from "element-plus";
import "element-plus/es/components/icon/style/css";

import ExecuteBlockFixture from "./components/ExecuteBlockFixture.vue";
import "./global.css";

const app = createApp(ExecuteBlockFixture);
app.component("ElIcon", ElIcon);
app.mount("#app");
