import { mount } from "svelte";
import "../app.css";
import Popup from "./Popup.svelte";

mount(Popup, { target: document.getElementById("app")! });
