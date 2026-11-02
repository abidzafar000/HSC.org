"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, Download, Leaf, Plus, ShieldCheck, Users, Warehouse, X } from "lucide-react";

type R = Record<string, any>;
type Props = {
  page: string;
  user: R;
  users: R[];
  locations: R[];
  busy: boolean;
  act: (action: string, payload: R, message?: string) => Promise<boolean>;
  api: (path: string, body?: R) => Promise<R>;
  onData: (data: R) => void;
  notify: (message: string, error?: boolean) => void;
};

const roles = [
  { value: "superadmin", label: "Super Admin", scope: "Complete control, users, locations and all operations" },
  { value: "admin", label: "Administrator", scope: "All locations, master data and independent approvals" },
  { value: "warehouse", label: "Warehouse", scope: "Warehouse dispatch, returns and stock adjustment requests" },
  { value: "purchasing", label: "Purchasing", scope: "Purchase GRNs and purchasing records" },
  { value: "branch", label: "Branch", scope: "Assigned branch receipts, returns and stock" },
  { value: "viewer", label: "Read only", scope: "View records and reports without changing stock" },
];
const roleName = (role: string) => roles.find(r => r.value === role)?.label || role;
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>;
}

export default function AdminPanel({ page, user, users, locations, busy, act, api, onData, notify }: Props) {
  const superadmin = user.role === "superadmin";
  const [editor, setEditor] = useState<R | null>(null);
  const [query, setQuery] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [working, setWorking] = useState(false);
  const branchName = (id: string) => locations.find(l => l.id === id)?.name || id;

  useEffect(() => { setEditor(null); setQuery(""); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }, [page]);
  useEffect(() => {
    if (!editor) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const elements = () => Array.from(document.querySelectorAll<HTMLElement>('.admin-editor button:not([disabled]),.admin-editor input:not([disabled]),.admin-editor select:not([disabled]),.admin-editor textarea:not([disabled])'));
    const timer = setTimeout(() => elements()[0]?.focus(), 20);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditor(null);
      if (event.key !== "Tab") return;
      const candidates = elements(), first = candidates[0], last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { clearTimeout(timer); document.removeEventListener("keydown", keyboard); document.body.style.overflow = overflow; previous?.focus(); };
  }, [editor?.kind]);

  function editUser(account?: R) {
    setEditor({ kind: "user", id: account?.id, name: account?.name || "", email: account?.email || "", role: account?.role || "branch", branchId: account?.branchId || locations.find(l => l.type === "branch")?.id || "B1", active: account?.active !== false && account?.active !== 0, password: "" });
  }
  function editLocation(location: R) {
    setEditor({ kind: "location", id: location.id, name: location.name, address: location.address || "", contact: location.contact || "", phone: location.phone || "" });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const { kind, ...values } = editor;
    if (kind === "user") {
      if (values.role !== "branch") values.branchId = null;
      if (!values.password) delete values.password;
    }
    if (await act(`${kind}.save`, values, kind === "user" ? "User access saved" : "Location details saved")) setEditor(null);
  }
  async function backup() {
    setWorking(true);
    try {
      const data = await api("backup");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `hamsun-phase1-backup-${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())}.json`;
      link.click(); URL.revokeObjectURL(url);
      notify("Backup downloaded");
    } catch (error: any) { notify(error.message, true); }
    finally { setWorking(false); }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) { notify("The new passwords do not match.", true); return; }
    setWorking(true);
    try {
      onData(await api("password", { currentPassword, newPassword }));
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      notify("Password updated. Other sessions have been signed out.");
    } catch (error: any) { notify(error.message, true); }
    finally { setWorking(false); }
  }

  return <>
    {page === "Access & roles" && <>
      <div className={`admin-hero ${superadmin ? "owner" : ""}`}>
        <span className="admin-emblem"><ShieldCheck size={27}/></span>
        <div><span className="eyebrow">YOUR WORKSPACE ACCESS</span><h2>{superadmin ? "You have Super Admin rights" : roleName(user.role)}</h2><p>{superadmin ? "Manage people, branch access, master data and every Phase 1 operation from one place." : roles.find(r => r.value === user.role)?.scope}</p></div>
        <span className="pill gold">{user.branchId ? branchName(user.branchId) : "All locations"}</span>
      </div>
      {superadmin && <section className="card admin-users">
        <div className="card-heading"><div><h2>People & access <span className="inline-count">{users.length}</span></h2><p>Give each person the role and location they need.</p></div><button className="button primary" disabled={busy} onClick={() => editUser()}><Plus size={16}/>Add user</button></div>
        <div className="admin-search"><input aria-label="Search users" placeholder="Search name, email or role…" value={query} onChange={e => setQuery(e.target.value)}/></div>
        <div className="table-scroll"><table><thead><tr><th>Person</th><th>Role</th><th>Location scope</th><th>Status</th><th/></tr></thead><tbody>{users.filter(account => `${account.name} ${account.email} ${account.role}`.toLowerCase().includes(query.toLowerCase())).map(account => <tr key={account.id}>
          <td><strong>{account.name}{account.id === user.id && <span className="you-label">You</span>}</strong><small className="block muted">{account.email}</small></td>
          <td><span className={account.role === "superadmin" ? "role-label super" : "role-label"}>{roleName(account.role)}</span></td>
          <td>{account.role === "branch" ? branchName(account.branchId) : "All locations"}</td>
          <td><span className={`badge status-${account.active === false || account.active === 0 ? "inactive" : "active"}`}><i/>{account.active === false || account.active === 0 ? "Inactive" : "Active"}</span></td>
          <td><button className="text-button" onClick={() => editUser(account)}>Manage access</button></td>
        </tr>)}</tbody></table></div>
        <div className="admin-card-note"><ShieldCheck size={15}/><p>Role and branch changes are recorded in the audit trail. Deactivating a user signs them out.</p></div>
      </section>}
      <section className="card role-reference"><div className="card-heading"><div><h2>Role permissions</h2><p>A clear responsibility for every person.</p></div><Users size={20}/></div><div className="role-grid">{roles.map(role => <div key={role.value}><span><ShieldCheck size={16}/></span><h3>{role.label}</h3><p>{role.scope}</p></div>)}</div></section>
    </>}

    {page === "Locations & settings" && (superadmin ? <>
      <div className="admin-hero"><span className="admin-emblem"><Warehouse size={27}/></span><div><span className="eyebrow">YOUR OPERATING NETWORK</span><h2>One warehouse. Four connected branches.</h2><p>Keep branch names, delivery addresses and contact details up to date.</p></div></div>
      <div className="settings-grid">{locations.map(location => <section className="card location-settings" key={location.id}><div className="location-settings-heading"><span className="network-icon"><Warehouse size={25}/></span><span className="pill">{location.type === "warehouse" ? "Central warehouse" : `Branch · ${location.id}`}</span></div><h2>{location.name}</h2><p>{location.address || "Add the delivery address for this location."}</p><div className="location-contact"><span>Contact<strong>{location.contact || "—"}</strong></span><span>Phone<strong>{location.phone || "—"}</strong></span></div><button className="button secondary full" onClick={() => editLocation(location)}>Edit location details</button></section>)}</div>
      <section className="card backup-card"><span className="admin-emblem"><Download size={23}/></span><div><h2>Download a workspace backup</h2><p>Save your product master, stock, documents, user access list and audit history.</p></div><button className="button primary" disabled={working} onClick={backup}><Download size={16}/>{working ? "Preparing…" : "Download backup"}</button></section>
    </> : <div className="info-banner"><ShieldCheck size={22}/><p>Location settings are managed by your Super Admin.</p></div>)}

    {page === "Security" && <section className="card security-card"><div className="card-heading"><div><h2>Your password</h2><p>Signed in as {user.email}</p></div><ShieldCheck size={23}/></div><form onSubmit={changePassword}><Field label="Current password"><input type="password" required autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}/></Field><Field label="New password"><input type="password" required minLength={10} autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)}/></Field><Field label="Confirm new password"><input type="password" required minLength={10} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}/></Field><p className="small muted">Use at least 10 characters. Your other signed-in sessions will be closed.</p><button className="button primary" disabled={working}>{working ? "Updating…" : "Update password"}<Check size={16}/></button></form></section>}

    {editor && <div className="modal-backdrop" onClick={() => !busy && setEditor(null)}><section className="modal admin-editor" role="dialog" aria-modal="true" aria-label={editor.kind === "user" ? `${editor.id ? "Manage" : "Add"} user` : "Edit location"} onClick={e => e.stopPropagation()}><header className="modal-header"><div><span className="eyebrow">SUPER ADMIN</span><h2>{editor.kind === "user" ? editor.id ? "Manage user access" : "Add a user" : "Location details"}</h2></div><button className="icon-button" aria-label="Close user settings" onClick={() => setEditor(null)}><X size={20}/></button></header><form onSubmit={save}><div className="modal-body"><div className="form-grid">
      {editor.kind === "user" ? <>
        <Field label="Full name *"><input required value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}/></Field>
        <Field label="Email address *"><input required type="email" autoComplete="off" value={editor.email} onChange={e => setEditor({ ...editor, email: e.target.value })}/></Field>
        <Field label="Role *"><select value={editor.role} disabled={editor.id === user.id} onChange={e => setEditor({ ...editor, role: e.target.value })}>{roles.map(role => <option value={role.value} key={role.value}>{role.label}</option>)}</select></Field>
        <Field label="Status"><select value={editor.active ? "active" : "inactive"} disabled={editor.id === user.id} onChange={e => setEditor({ ...editor, active: e.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
        {editor.role === "branch" && <Field label="Assigned branch *" wide><select required value={editor.branchId} onChange={e => setEditor({ ...editor, branchId: e.target.value })}>{locations.filter(location => location.type === "branch").map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></Field>}
        <Field label={editor.id === user.id ? "Your password" : editor.id ? "Set a new password (optional)" : "Initial password *"} wide><input type="password" required={!editor.id} disabled={editor.id === user.id} minLength={10} autoComplete="new-password" value={editor.password} onChange={e => setEditor({ ...editor, password: e.target.value })} placeholder={editor.id === user.id ? "Change your own password from Security" : editor.id ? "Leave blank to keep the current password" : "At least 10 characters"}/></Field>
        <p className="field wide small muted">{editor.id === user.id ? "Your own Super Admin role and active access remain protected." : roles.find(role => role.value === editor.role)?.scope}</p>
      </> : <>
        <Field label="Location name *" wide><input required value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}/></Field>
        <Field label="Delivery address" wide><textarea rows={3} value={editor.address} onChange={e => setEditor({ ...editor, address: e.target.value })}/></Field>
        <Field label="Contact person"><input value={editor.contact} onChange={e => setEditor({ ...editor, contact: e.target.value })}/></Field>
        <Field label="Phone"><input type="tel" value={editor.phone} onChange={e => setEditor({ ...editor, phone: e.target.value })}/></Field>
      </>}
    </div></div><footer className="modal-footer"><span className="small muted">Changes are recorded in the audit trail</span><button type="button" className="button secondary" onClick={() => setEditor(null)}>Cancel</button><button className="button primary" disabled={busy}>Save changes<Check size={15}/></button></footer></form></section></div>}
    <div className="admin-footer-note"><Leaf size={13}/>Hamsun Phase 1 · Controlled access, clear accountability.</div>
  </>;
}
