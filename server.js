import env from "./env.js";
import app from "./app.js";

app.listen(env.port, () => {
  console.log(`server listening at port ${env.port}...`);
});
