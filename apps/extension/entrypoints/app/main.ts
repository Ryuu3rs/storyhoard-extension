import { mount } from "svelte"
import App from "./App.svelte"
import { primeSidebarCollapsed } from "../../src/sidebar-pref"
import { primeStartSection } from "../../src/start-page"
import "./style.css"

void Promise.all([primeSidebarCollapsed(), primeStartSection()]).then(() =>
    mount(App, {
        target: document.getElementById("app")!
    })
)
