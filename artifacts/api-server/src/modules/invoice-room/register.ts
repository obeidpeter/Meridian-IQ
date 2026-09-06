import { registerSweep } from "../pipeline/sweeps";
import { sweepInvoiceRoomReminders } from "./service";

registerSweep("invoice_room.reminders", () => sweepInvoiceRoomReminders());
