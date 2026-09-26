import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp.js";
import "../chat-shell/chat-shell.css";
import "../app/app.css";

createRoot(document.getElementById("root")!).render(<MobileApp />);
