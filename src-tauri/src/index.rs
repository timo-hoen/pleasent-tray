//! In-memory folder tree. Holds metadata only: passwords and notes are never
//! deserialized from the server response.

use crate::edit::EntryInput;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
pub struct Folder {
    pub id: Option<String>,
    pub name: Option<String>,
    pub children: Option<Vec<Folder>>,
    pub credentials: Option<Vec<Credential>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
pub struct Credential {
    pub id: String,
    pub name: Option<String>,
    pub username: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub id: String,
    pub name: String,
    pub username: String,
    pub url: String,
    pub path: String,
}

/// Folder view for the UI.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreeNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub children: Vec<TreeNode>,
    pub entries: Vec<Hit>,
}

/// Paths match the search hits: the root's own name is left out. Folders may share a
/// name, so the id comes from the server, or from the position if the server sends none.
pub fn build_tree(folder: &Folder, path: &str, position: &str) -> TreeNode {
    let mut entries: Vec<Hit> = folder
        .credentials
        .iter()
        .flatten()
        .map(|c| Hit {
            id: c.id.clone(),
            name: c.name.clone().unwrap_or_default(),
            username: c.username.clone().unwrap_or_default(),
            url: c.url.clone().unwrap_or_default(),
            path: path.to_string(),
        })
        .collect();
    entries.sort_by_key(|e| e.name.to_lowercase());
    let mut children: Vec<TreeNode> = folder
        .children
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, child)| {
            let name = child.name.as_deref().unwrap_or_default();
            let child_path =
                if path.is_empty() { name.to_string() } else { format!("{path} / {name}") };
            build_tree(child, &child_path, &format!("{position}.{i}"))
        })
        .collect();
    children.sort_by_key(|c| c.name.to_lowercase());
    TreeNode {
        id: folder.id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| position.to_string()),
        name: folder.name.clone().unwrap_or_default(),
        path: path.to_string(),
        children,
        entries,
    }
}

impl TreeNode {
    pub fn entry_count(&self) -> usize {
        self.entries.len() + self.children.iter().map(TreeNode::entry_count).sum::<usize>()
    }

    /// Changes a known entry, as the server stores it. Returns false if the id is unknown.
    pub fn update_entry(&mut self, id: &str, input: &EntryInput) -> bool {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
            entry.name = input.name.trim().to_string();
            entry.username = input.username.trim().to_string();
            entry.url = input.url.trim().to_string();
            self.entries.sort_by_key(|e| e.name.to_lowercase());
            return true;
        }
        self.children.iter_mut().any(|child| child.update_entry(id, input))
    }

    /// Adds a new entry to a folder. Returns false if the folder is unknown.
    pub fn add_entry(&mut self, group_id: &str, id: &str, input: &EntryInput) -> bool {
        if self.id == group_id {
            self.entries.push(Hit {
                id: id.to_string(),
                name: input.name.trim().to_string(),
                username: input.username.trim().to_string(),
                url: input.url.trim().to_string(),
                path: self.path.clone(),
            });
            self.entries.sort_by_key(|e| e.name.to_lowercase());
            return true;
        }
        self.children.iter_mut().any(|child| child.add_entry(group_id, id, input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TreeNode {
        let root: Folder = serde_json::from_str(
            r#"{"Name":"Root","Children":[
                {"Id":"b","Name":"Zeta","Credentials":[
                  {"Id":"3","Name":"VPN","Username":"admin","Password":"geheim","Notes":"notiz"}
                ]},
                {"Name":"alpha","Credentials":[{"Id":"2","Name":"Z"},{"Id":"1","Name":"a"}]}
            ]}"#,
        )
        .unwrap();
        build_tree(&root, "", "0")
    }

    #[test]
    fn keeps_structure_and_sorts_folders_and_entries() {
        let tree = sample();
        assert_eq!(tree.name, "Root");
        assert_eq!(tree.children[0].name, "alpha");
        assert_eq!(tree.children[0].path, "alpha");
        assert_eq!(tree.children[0].id, "0.1");
        assert_eq!(tree.children[1].id, "b");
        assert_eq!(tree.children[0].entries[0].id, "1");
    }

    fn input(name: &str) -> EntryInput {
        EntryInput {
            name: format!(" {name} "),
            username: "neu".into(),
            url: "https://x.example".into(),
            notes: "notiz".into(),
            password: Some("geheim".into()),
            totp: None,
        }
    }

    #[test]
    fn updates_one_entry_keeps_order_and_never_stores_secrets() {
        let mut tree = sample();
        assert!(tree.update_entry("1", &input("zz")));
        let alpha = &tree.children[0];
        assert_eq!(alpha.entries[1].id, "1");
        assert_eq!(alpha.entries[1].name, "zz");
        assert_eq!(alpha.entries[1].username, "neu");
        let json = serde_json::to_string(&tree).unwrap();
        assert!(!json.contains("geheim") && !json.contains("notiz"));
    }

    #[test]
    fn unknown_entry_or_folder_reports_false() {
        let mut tree = sample();
        assert!(!tree.update_entry("nope", &input("x")));
        assert!(!tree.add_entry("nope", "9", &input("x")));
        assert_eq!(tree.entry_count(), 3);
    }

    #[test]
    fn adds_entry_with_the_folder_path() {
        let mut tree = sample();
        assert!(tree.add_entry("b", "9", &input("Alpha")));
        let zeta = &tree.children[1];
        assert_eq!(zeta.entries[0].id, "9");
        assert_eq!(zeta.entries[0].path, "Zeta");
        assert_eq!(tree.entry_count(), 4);
    }

    #[test]
    fn counts_entries_in_all_folders() {
        assert_eq!(sample().entry_count(), 3);
    }

    #[test]
    fn never_exposes_password_or_notes() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(!json.contains("geheim"));
        assert!(!json.contains("notiz"));
    }
}
