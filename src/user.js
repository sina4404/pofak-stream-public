// Manage accounts from the command line (works while the server runs):
//   docker compose exec mintstream node src/user.js add <name> "<password>"   (also changes a password)
//   docker compose exec mintstream node src/user.js remove <name>
//   docker compose exec mintstream node src/user.js list
import { getUsers, saveUser, removeUser } from './users.js';

const [cmd, name, password] = process.argv.slice(2);

try {
  if (cmd === 'add' && name && password) {
    saveUser(name, password);
    console.log(`Saved account "${name}".`);
  } else if (cmd === 'remove' && name) {
    console.log(removeUser(name) ? `Removed "${name}" (they are logged out).` : `No account "${name}" in data/users.json.`);
  } else if (cmd === 'list') {
    const names = [...getUsers().values()].map((u) => u.name);
    console.log(names.length ? names.join('\n') : 'No accounts yet.');
  } else {
    console.log('Usage:\n  node src/user.js add <name> "<password>"\n  node src/user.js remove <name>\n  node src/user.js list');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
