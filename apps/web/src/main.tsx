import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ControlPanel from "./ControlPanel";
import { EmbedGate } from "./EmbedGate";
import { embedded } from "./sportsbook-api";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname === "/control/sportsbook-preview" ? <App readOnlyPreview/> : location.pathname === "/control" ? <ControlPanel/> : embedded ? <EmbedGate><App/></EmbedGate> : <App/>}
  </React.StrictMode>,
);
