# Siri: “Log time”

This connects a private Apple Shortcut to the Render app. Apple handles dictation; the app sends the text to OpenAI to extract a time entry. Nothing is written until you choose **Save**. You do not need to open Safari or sign into the website.

## 1. Deploy the update

Push the updated code, then add `SHORTCUT_TOKEN` under your Render service's **Environment** settings. Generate a random 64-character secret using a password manager, or locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save and redeploy. Keep your existing settings. `SHORTCUT_TOKEN` is a separate secret from `SESSION_SECRET`, the app password, and your OpenAI/Notion keys. A new Blueprint generates it automatically; an existing service needs it added manually.

Have these two values ready:

- Your app URL, such as `https://spoken-minutes.onrender.com` (use your real URL).
- Your `SHORTCUT_TOKEN` value.

## 2. Create the shortcut on your iPhone

Open **Shortcuts**, tap **+**, and name it **Log time**. Add the following actions in order. Action names can vary slightly by iOS version. Where a value is in square brackets, select the corresponding variable using the variable picker; do not type the brackets or variable name as literal text.

### Collect the note

1. Add **Text** containing your `SHORTCUT_TOKEN`. Add **Set Variable** and name it `ShortcutToken`.
2. Add **Speak Text**: `What did you work on, for how long, and on which project?` Leave **Wait Until Finished** enabled.
3. Add **Dictate Text**. Set the language you use, and **Stop Listening** to **After Pause**. This action requests microphone/speech permissions the first time.
4. Add **Set Variable**, named `Note`, using the dictated text.

### Prepare and read back

5. Add **Get Contents of URL**:

   | Setting | Value |
   | --- | --- |
   | URL | `https://YOUR-APP.onrender.com/api/shortcuts/prepare` |
   | Method | `POST` |
   | Header: `Authorization` | Type `Bearer ` (with a trailing space), then insert `[ShortcutToken]` |
   | Header: `Content-Type` | `application/json` |
   | Request Body | `JSON` |
   | JSON field `transcript` | Type **Text**, value `[Note]` |

6. Add **Set Variable**, named `Draft`, using the result of that request.
7. Add **Get Dictionary Value**: key `message`, in `[Draft]`.
8. Add **Speak Text**, using that dictionary value. Leave **Wait Until Finished** enabled. For example: “16 minutes on Project B: Email stakeholders, dated 2026-10-25. Save this entry?”
9. Add **Get Dictionary Value**: key `canSave`, in `[Draft]`.
10. Add **If** that value **is true** (Boolean). Depending on iOS, it may be displayed as **is Yes**. Do not use **has any value**, because `false` is also a value. If your editor treats the result as text, compare it to the text `true` instead.

### Confirm and save

11. **Inside the If branch**, add **Choose from Menu**, prompt `Save this entry?`, with options **Save** and **Cancel**.
12. **Inside Save**, add **Get Dictionary Value**: key `draftId`, in `[Draft]`. Add **Set Variable**, named `DraftID`.
13. Still inside Save, add **Get Contents of URL**:

    | Setting | Value |
    | --- | --- |
    | URL | `https://YOUR-APP.onrender.com/api/shortcuts/save` |
    | Method | `POST` |
    | Header: `Authorization` | `Bearer [ShortcutToken]` (insert the variable) |
    | Header: `Content-Type` | `application/json` |
    | Request Body | `JSON` |
    | JSON field `draftId` | Type **Text**, value `[DraftID]` |
    | JSON field `confirmed` | Type **Boolean**, value **true / Yes** |

14. Still inside Save, add **Get Dictionary Value**: key `message`, in the result of the save request, then **Speak Text** using that value. Do not hard-code “Saved”: the returned message reports success or an error.
15. **Inside Cancel**, add **Speak Text**: `Cancelled. Nothing saved.`
16. Leave the **Otherwise** branch of the outer If empty. The earlier readback already explains incomplete entries or errors; it must not call the save endpoint.

The completed structure should look like this:

```text
Text: shortcut token → Set Variable: ShortcutToken
Speak Text: ask what was worked on
Dictate Text → Set Variable: Note
POST /api/shortcuts/prepare → Set Variable: Draft
Get message from Draft → Speak Text
Get canSave from Draft
If canSave is true
    Choose from Menu: Save / Cancel
        Save:
            Get draftId from Draft → Set Variable: DraftID
            POST /api/shortcuts/save (draftId, confirmed: true)
            Get message from save response → Speak Text
        Cancel:
            Speak Text: Cancelled. Nothing saved.
Otherwise
    (no actions)
End If
```

## 3. Try it

First run it by tapping the shortcut, and approve the requested speech and network permissions. Then say **“Siri, log time”**, wait for the prompt, and say **“I spent 16 minutes emailing stakeholders on Project B.”** Pause to finish dictation, listen to the readback, and choose **Save**. Check that exactly one row appears in Project B's Time Spent table. Try **Cancel** as well and verify no row is added.

When Siri runs the menu, iOS may let you answer aloud; otherwise select Save or Cancel on screen. Siri can require the phone to be unlocked, depending on its settings and actions. A cold or sleeping Render service can delay requests; if Shortcuts times out during a save, inspect Notion before trying a new entry. Do not automatically repeat the whole shortcut after a save failure.

If Dictate Text does not capture speech reliably while Siri is active on your iOS version, add **Dismiss Siri and Continue** before Dictate Text, if that action is available. This falls back to the on-screen dictation interface. The workflow still avoids website login.

## Notes

- Say one entry at a time. Missing or ambiguous details produce a spoken explanation and no saveable draft.
- Drafts expire after ten minutes and are lost on server restarts. A repeated save request for the same draft returns the saved result within that period and running process. An uncertain save is never automatically retried.
- Only the server-held draft is saved; changing fields in the save request cannot change the reviewed entry.
- The shortcut token gives access to this app's Siri prepare/save endpoints. Keep the shortcut private. Remove the token before sharing a template; other users must configure their own authorized token. Rotating `SHORTCUT_TOKEN` revokes the old shortcut without changing browser sign-ins.
- The POC uses one shared shortcut token and Notion workspace. It does not identify individual staff members. Per-user tokens/accounts are a separate enhancement.
- These steps must be assembled in Apple's Shortcuts app. This repository does not contain a signed, one-tap installable `.shortcut` file. A configured shortcut can be shared from an iPhone after removing its secret.

Apple references: [API requests and JSON bodies](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios) and [Choose from Menu](https://support.apple.com/guide/shortcuts/use-the-choose-from-menu-action-apdd7bf369da/ios).

## API reference

Both routes accept only `POST` with `Content-Type: application/json` and `Authorization: Bearer <SHORTCUT_TOKEN>`. Neither needs a browser session. The token does not grant access to browser login, project listing, or normal entry endpoints.

`/api/shortcuts/prepare` accepts `{"transcript":"I spent 16 minutes emailing stakeholders on Project B"}`. A complete entry returns:

```json
{"ok":true,"canSave":true,"draftId":"server-generated-uuid","summary":"16 minutes on Project B: Email stakeholders, dated 2026-10-25.","message":"16 minutes on Project B: Email stakeholders, dated 2026-10-25. Save this entry?"}
```

An incomplete entry returns `{"ok":true,"canSave":false,"message":"..."}` without a draft ID.

`/api/shortcuts/save` accepts `{"draftId":"server-generated-uuid","confirmed":true}`. A successful save returns `{"ok":true,"id":"notion-page-id","url":"https://...","message":"Saved. ..."}`.

Failures return an appropriate non-2xx status with `{"ok":false,"error":"...","message":"..."}`. A network or HTTP error may cause Shortcuts to stop before the readback. This must not be treated as success. Draft creation is limited to 30 requests per ten minutes per server, with one preparation at a time.
