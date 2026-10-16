# NDIS Wizard demo

The NDIS Wizard demo app (original design) with a **Live agents · ShiftCare** section. Penny, Clancy, Cleo, Hey Wizard and the one-job agents run on the `ndis-wizard` API, which reads the NDIS Wizard ShiftCare Dummy (synthetic data only). Nothing is sent or written back; every result waits in the review queue for a person.

**Clancy · Xero** compares the ShiftCare clone with a mock Xero organisation (Accounting and Payroll AU) that the clone syncs to the way ShiftCare's Xero integration does. It lists invoices, payments, contacts, staff links, pay item mappings and timesheets that disagree between the two systems.

Open the site and go to **Live agents** in the sidebar. For testing, the page signs in automatically as a demo Director; sign out to pick another role.
