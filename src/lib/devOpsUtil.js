
const yaml = require('js-yaml');
const fs = require('fs');
const fspr = require('fs').promises;
var path = require('path')
const JSON5 = require('json5')




async function getFileListFromLocal(dir, arr) {
    const result = await fspr.readdir(dir);

    let prom = result.map(async (file) => {
        file = path.resolve(dir, file);
        const element = await fspr.stat(file);

        if (element.isDirectory()) {
            const newar = await getFileListFromLocal(file, arr);

            arr.concat(newar);
        }
        else {
            arr.push({ path: file, type: "local" })
        }

    })
    await Promise.all(prom);



    return arr;
}

async function generateServerlessFunction(templateFile) {
    let fileList = await getFileListFromLocal("./src/lambda", []);

    const apiSpecList = await getApiSepcList(fileList);

    await printServerlessFunction(templateFile, apiSpecList);
}


function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function replaceHttpMethod(_str) {

    let str = _str.replace("/post", "");
    str = str.replace("/get", "");
    str = str.replace("/put", "");
    str = str.replace("/delete", "");
    return str;

}
function replaceAll(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
}
async function getApiSepcList(files) {
    let cnt = 0;
    console.log(files);

    let apiSpecList = { "nomatch": [], "error": [] };
    function processFile(fileItem) {
        return new Promise(async (resolve, reject) => {
            const path = fileItem.path;
            if (path.includes("codeCommitExample") || path.includes("onCodePushed")) {
                console.log(cnt++, "codeCommitExample");
                resolve("ok");
            }
            try {
                let utf8 = undefined;
                let category = "";
                let name = "";
                let file = undefined;
                if (fileItem.type == "local") {
                    name = path.replace(".js", "");
                    name = replaceAll(name, "\\\\", "/");
                    let nameArr = name.split("/");

                    const idxLambda = nameArr.indexOf("lambda");
                    nameArr = nameArr.slice(idxLambda - 1);
                    name = nameArr.slice(2).join("/");
                    category = nameArr[2];
                    try {
                        file = await fspr.readFile(path);
                    }
                    catch (e) {
                        console.error(e);
                    }

                    utf8 = file.toString('utf8');


                }


                //  const decoded = Base64.decode(fileContentEncoded)
                let regexstr = `(?<=apiSpec = )((.|\n|\r)*?)(?=\;)`;
                var regex = new RegExp(regexstr, "g");
                var matches = utf8.matchAll(regex)
                const matchArray = Array.from(matches);
                for (const match of matchArray) {
                    try {
                        let obj = JSON5.parse(match[0]);
                        category = obj.category;
                        obj["name"] = name;
                        obj["uri"] = replaceHttpMethod(name);
                        console.log(cnt++, path, obj);
                        if (!apiSpecList[category]) {
                            apiSpecList[category] = [];
                        }
                        apiSpecList[category].push({ path: path, item: obj })
                    } catch (e) {
                        apiSpecList["error"].push({ path: path, obj: "error" })
                        console.log(match[0]);
                        console.error(path);
                        console.error(e);
                    }
                }
                if (matchArray.length < 1) {

                    console.log(cnt++, path, "\u001b[1;31m no_match")
                    apiSpecList["nomatch"].push({ path: path, obj: "no_match" })
                }

            }
            catch (e) {
                console.error(e);
            }

            resolve("ok");
        });
    }
    await files.reduce(async (previousPromise, nextID) => {
        await previousPromise;
        return processFile(nextID);
    }, Promise.resolve());
    return apiSpecList;
}


function createPostmanImport(apiSpecList, title, stage, _version, host) {



    const projectInfo = yaml.load(fs.readFileSync('./info.yml', "utf8"));

    const description = projectInfo.description;
    const contact = projectInfo.contact;
    const version = `${stage}-${_version}`;
    const servers = [{ url: host }];
    const schemes = ["https"];
    let paths = {};
    const obj = sortApiSpecListByPath(apiSpecList);
    console.log(obj);
    for (var property in obj) {
        paths[property] = {};
        for (var method in obj[property]) {
            const api = obj[property][method];
            paths[property][method] = {};
            paths[property][method].descroption = api.desc;
            if (!api.noAuth) {
                paths[property][method].security =
                    [{
                        bearerAuth: ["test"]
                    }]
            }
            paths[property][method].parameters = [];
            if (method == "get" || method == "delete") {
                for (var parmName in api.parameters) {
                    const parm = api.parameters[parmName];

                    paths[property][method].parameters.push(
                        {
                            name: parmName,
                            in: "query",
                            description: parm.desc,
                            required: parm.req,
                            schema: { type: parm.type.toLowerCase() }
                        }
                    )

                }
            }
            if (method == "post" || method == "put") {
                let requireds = [];
                let proprs = {};
                for (var parmName in api.parameters) {
                    const parm = api.parameters[parmName];
                    if (parm.req) {
                        requireds.push(parmName);
                    }
                    proprs[parmName] = {
                        type: parm.type
                    }
                }
                paths[property][method].requestBody = {
                    required: true,
                    content: {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": requireds,
                                "properties": proprs,
                            }
                        }
                    }
                }

            }

        }
    }
    const all = {
        "openapi": "3.0.0",
        info: {

            version: version,
            title: `${title}(${stage})`,
            description: description,
            contact: contact,

        },
        servers: servers,
        paths: paths,
        components: {
            securitySchemes:
            {
                bearerAuth:
                {
                    type: "http",
                    scheme: "bearer"
                }
            }
        }
    }
    return (JSON.stringify(all));
}
function sortApiSpecListByPath(apiSpecList) {
    let obj = {};
    for (var category in apiSpecList) {
        const prop = apiSpecList[category];
        prop.forEach((itemt) => {
            const item = itemt.item;
            if (!item || !item.type || item.hide || !item.method) {
                return;
            }

            if (!obj[item.uri]) {
                obj[item.uri] = [];
            }
            obj[item.uri][item.method.toLowerCase()] = item;


        })

    }
    return obj;
}
async function printServerlessFunction(templateFile, apiSpecList) {
    let fncs = "";
    let cnt = 0;
    let filenum = 1;
    let serverlessTemplet1 = yaml.load(fs.readFileSync(templateFile, "utf8"))
    let functions = {};

    for (var property in apiSpecList) {

        let apiSpec = apiSpecList[property];
        if (apiSpec.length > 0) {
            apiSpec.forEach(async (obj) => {

                const item = obj.item;
                if (item && (item.method) && (!item.disabled)) {

                    const nameArr = item.name.split("/");
                    let funcObject = {
                        name: `\${self:app}_\${opt:stage, "dev"}\${opt:ver, "1"}_${nameArr.join("_")}`,
                        handler: `src/lambda/${item.name}.handler`,
                        //alarms: ["scan500Error"],
                        alarms: [{ name: "functionErrors", enabled: (process.env.stage == "prod") ? true : false }],

                        events: [
                            {
                                http: {
                                    path: `${item.uri}`,
                                    method: `${item.method.toLowerCase()}`,
                                    cors: true,
                                }
                            }
                        ]
                    }
                    if (item.layer) {
                        funcObject["layers"] = [item.layer]
                    }
                    if (item.timeout) {
                        funcObject["timeout"] = parseInt(item.timeout);
                    }
                    functions[`${nameArr.join("_")}`] = funcObject;



                }

            });


        }

        // serverlessTemplet1.service = `${serverlessTemplet1.service}${filenum}`;
        // serverlessTemplet1.provider.stackName = `${serverlessTemplet1.provider.stackName}${filenum}`;


    }
    serverlessTemplet1.functions = functions;
    let yamlStr = yaml.dump(serverlessTemplet1);
    fs.writeFileSync(`serverless.yml`, yamlStr, 'utf8');
}

module.exports.generateServerlessFunction = generateServerlessFunction;

//handleCommit("tw_rnd_backend_smartstay_nodejs");
