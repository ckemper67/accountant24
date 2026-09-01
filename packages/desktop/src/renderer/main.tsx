import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DiagErrorBoundary } from "./components/accountant24/diag-error-boundary";
import { installRendererDiag } from "./lib/diag";
import { syncSystemTheme } from "./lib/systemTheme";
import "./index.css";

syncSystemTheme();
installRendererDiag();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiagErrorBoundary>
      <App />
    </DiagErrorBoundary>
  </React.StrictMode>,
);
