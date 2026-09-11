// Tests composeEmail against Karley's two reference emails.
// The function is extracted from app.js so it can run without a DOM.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = src.indexOf("export function composeEmail");
const end   = src.indexOf('$("genEmailBtn")');
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
const composeEmail = (new Function("esc", src.slice(start, end).replace("export ", "") +
  "; return composeEmail;"))(esc);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
};
const row = (size, counted, po) => ({ size, counted, po, d: counted - po });

/* ---------- Example 1: discrepancies, one style-color ---------- */
console.log("\nExample 1 — PO# 45032, AC6776-Fuchsia");
const ex1 = composeEmail({
  po: "45032", adj: "", blocks: [{
    styleColor: "AC6776-Fuchsia",
    rows: [
      row("Y6", 13, 15), row("Y8", 39, 48), row("Y10", 39, 48), row("Y14", 39, 50),
      row("XS", 0, 73), row("S", 179, 196), row("M", 88, 88), row("L", 92, 92),
      row("XL", 45, 47), row("2XL", 30, 30), row("3XL", 16, 18), row("4XL", 12, 14),
    ],
  }],
});
console.log("\n--- subject ---\n" + ex1.subject + "\n--- body ---\n" + ex1.text + "\n");

check("subject is 'PO# 45032 Discrepancies'", ex1.subject === "PO# 45032 Discrepancies", ex1.subject);
check("opens with the greeting", ex1.text.startsWith("Hi Tristan,\n\n"));
check("intro names the single item", ex1.text.includes("item is AC6776-Fuchsia and have these discrepancies."));
check("asks the adjustment-or-more-stock question",
  ex1.text.includes("Would you like us to do an inventory adjustment or is there more stock we are missing?"));
check("the 'I assume it is the second' aside is gone", !ex1.text.includes("I assume it is the second"));
check("has the counts header", ex1.text.includes("Here are our counts:"));
check("Y6 line matches format", ex1.text.includes("Y6 counted 13 PO has 15 off by -2"));
check("Y8 line matches format", ex1.text.includes("Y8 counted 39 PO has 48 off by -9"));
check("XS computes -73 (your example said 73)", ex1.text.includes("XS counted 0 PO has 73 off by -73"));
check("S line matches format", ex1.text.includes("S counted 179 PO has 196 off by -17"));
check("matching sizes marked good", ex1.text.includes("M was good") && ex1.text.includes("L was good") && ex1.text.includes("2XL was good"));
check("every one of the 12 sizes is listed", ["Y6","Y8","Y10","Y14","XS","S","M","L","XL","2XL","3XL","4XL"]
  .every((s) => new RegExp("^" + s.replace(/\+/g,"\\+") + " ", "m").test(ex1.text)));
check("discrepancy lines are bolded in html", (ex1.html.match(/<strong>/g) || []).length === 9,
  "expected 9 bold rows, got " + (ex1.html.match(/<strong>/g) || []).length);
check("'was good' lines are NOT bolded", !/<strong>[^<]*was good/.test(ex1.html));

/* ---------- Example 2: adjustment made ---------- */
console.log("\nExample 2 — PO 45132, adjustment #34450");
const ex2 = composeEmail({
  po: "45132", adj: "34450", blocks: [{
    styleColor: "AC6900-Black",
    rows: [row("XS", 83, 84), row("S", 40, 40), row("M", 50, 50)],
  }],
});
console.log("\n--- subject ---\n" + ex2.subject + "\n--- body ---\n" + ex2.text + "\n");

check("subject is 'PO 45132' (no # and no 'Discrepancies')", ex2.subject === "PO 45132", ex2.subject);
check("exact Example 2 wording", ex2.text ===
  "On PO 45132 we received all items in full but we were off by 1 in size XS. " +
  "We counted 83, the PO listed 84 purchased, count was off -1. " +
  "We did an inventory adjustment subtracting 1 for the difference. " +
  "Inventory Adjustment number is #34450 if needed.", ex2.text);
check("says 'subtracting' when short", ex2.text.includes("subtracting 1"));

/* ---------- generalisations ---------- */
console.log("\nGeneralisations beyond the two examples");
const over = composeEmail({ po: "1", adj: "999", blocks: [{ styleColor: "X-Y", rows: [row("M", 12, 10)] }] });
check("says 'adding' when over", over.text.includes("adding 2"));

const multi = composeEmail({ po: "77", adj: "", blocks: [
  { styleColor: "AC6833-Ivory", rows: [row("S", 5, 6)] },
  { styleColor: "AC6833-Navy",  rows: [row("S", 4, 4)] },
]});
check("multi style-color drops the singular 'item is'", !multi.text.includes("item is"));
check("multi style-color labels each block", multi.text.includes("AC6833-Ivory") && multi.text.includes("AC6833-Navy"));
check("block headings bolded in html", multi.html.includes("<strong>AC6833-Ivory</strong>"));

const clean = composeEmail({ po: "88", adj: "", blocks: [{ styleColor: "A-B", rows: [row("M", 5, 5)] }] });
check("all-matched subject differs", clean.subject === "PO# 88 counts matched");
check("all-matched body still lists every size", clean.text.includes("M was good"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
