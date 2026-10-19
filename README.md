# NDIS Wizard demo

The NDIS Wizard demo app (original design) with a **Live agents · ShiftCare** section. Penny, Clancy, Cleo, Hey Wizard and the one-job agents run on the `ndis-wizard` API, which reads the NDIS Wizard ShiftCare Dummy (synthetic data only). Nothing is sent or written back; every result waits in the review queue for a person.

**Clancy · Xero** compares the ShiftCare clone with a mock Xero organisation (Accounting and Payroll AU) that the clone syncs to the way ShiftCare's Xero integration does. It lists invoices, payments, contacts, staff links, pay item mappings and timesheets that disagree between the two systems.

**Approving applies the fix.** When a reviewer approves an item, the Wizard makes the change in the ShiftCare clone and/or Xero (export the invoice, record the payment, link the staff member, fix the draft invoice line, raise the incident) and the **Recent changes** page shows every row that changed, grouped under the approval that caused it. The clone has a matching Recent changes page, so you can confirm from the ShiftCare side.

Open the site and go to **Live agents** in the sidebar. For testing, the page signs in automatically as a demo Director; sign out to pick another role.

## Astalty copy

The same demo can read an **Astalty clone** instead of the ShiftCare clone. The clone is a synthetic replica of Astalty's public API (`/public/v1`, bearer tokens) with its own data set and planted errors; see [`astalty-clone/README.md`](astalty-clone/README.md). Open the demo with `?source=astalty` on the URL and every agent call goes to Astalty; the Wizard API accepts the same `?source=astalty` switch. Browse the clone itself at [`astalty-clone/console.html`](astalty-clone/console.html) with an API token.
