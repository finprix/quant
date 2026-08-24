import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { DatasetProvider } from "./context/DatasetContext.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import "./styles/global.css";
import "./styles/compare.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <DatasetProvider>
          <App />
        </DatasetProvider>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>,
);
