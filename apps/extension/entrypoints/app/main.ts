import { mount } from "svelte"
import App from "./App.svelte"
import { primeSidebarCollapsed } from "../../src/sidebar-pref"
import "./style.css"

void primeSidebarCollapsed().then(() =>
    mount(App, {
        target: document.getElementById("app")!
    })
)
