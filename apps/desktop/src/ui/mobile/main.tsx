import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp.js";
import { intlLocale, setLocale } from "../../i18n/index.js";
import "../chat-shell/chat-shell.css";
import "../app/app.css";

// Phone pages follow the phone's system language.
setLocale(navigator.languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en");
document.documentElement.lang = intlLocale();

createRoot(document.getElementById("root")!).render(<MobileApp />);
