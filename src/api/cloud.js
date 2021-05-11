const axios = require("axios");

const cloudConfig = require("../conf/cloud");

class CloudAPI {
  constructor() {
    this.prefix = "https://api.weixin.qq.com";
  }

  getAccessToken() {
    return axios({
      url: `${this.prefix}/cgi-bin/token`,
      method: "get",
      params: {
        grant_type: cloudConfig.grant_type,
        appid: cloudConfig.appid,
        secret: cloudConfig.secret,
      },
    });
  }

  invokeCloudFunction(opts) {
    return axios({
      url: `${this.prefix}/tcb/invokecloudfunction`,
      method: "post",
      params: {
        env: opts.env,
        access_token: opts.access_token,
        name: opts.name,
      },
      data: opts.POSTBODY,
    });
  }
}

module.exports = new CloudAPI();
