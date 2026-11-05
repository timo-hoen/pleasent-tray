import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { UpdateNotice } from "@/components/UpdateNotice";
import "@/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

document.addEventListener("contextmenu", (event) => event.preventDefault());

createRoot(root).render(
  <StrictMode>
    <App />
    <UpdateNotice />
  </StrictMode>,
);
