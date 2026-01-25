import base64
import os
import queue
import re
import shutil
import urllib
import urllib.request
import urllib.response

domain_pattern = re.compile(r'[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(?:\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+')
exclude_domains = []

clash_support_types = [
    # "RULE-SET",
    "DOMAIN",
    "DOMAIN-SUFFIX",
    "DOMAIN-KEYWORD",
    "GEOIP",
    "IP-CIDR",
    "IP-CIDR6",
    "SRC-IP-CIDR",
    "SRC-PORT",
    "DST-PORT",
    # "PROCESS-NAME",
    # "MATCH",
]

clash_ip_types = [
    "GEOIP",
    "IP-CIDR",
    "IP-CIDR6",
]

mosdns_whitelist_urls = [
    "https://rawstatic.com/nexitallyy/ProxyRules/main/Extra_CN_3.list",
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/CustomDirect.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Direct/Direct.list",
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/EmbyPorn.list",
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/EmbyTLS.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Apple/Apple.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Download/Download.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Game/GameDownloadCN/GameDownloadCN.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Game/GameDownload/GameDownload.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Speedtest/Speedtest.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Epic/Epic.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Xbox/Xbox.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/ChinaMedia/ChinaMedia.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/China/China.list",
]

mosdns_blacklist_urls = [
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/CustomProxy.list",
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/EmbyTerminus.list",
    "https://raw.githubusercontent.com/alecthw/chnlist/main/clash/LastWar.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Rockstar/Rockstar.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Telegram/Telegram.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/PayPal/PayPal.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Binance/Binance.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/OKX/OKX.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/OpenAI/OpenAI.list",
    # "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Steam/Steam.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/UBI/UBI.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Ubisoft/Ubisoft.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Nintendo/Nintendo.list",
    # "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Microsoft/Microsoft.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Disney/Disney.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Netflix/Netflix.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Spotify/Spotify.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/AmazonPrimeVideo/AmazonPrimeVideo.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/HBO/HBO.list",
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/ProxyLite/ProxyLite.list",
]

quanx_script_urls = {
    "百度网盘": "https://raw.githubusercontent.com/510004015/Quantumult_X/Remote/Premium/BaiduCloud.js",
    "百度文库": "https://raw.githubusercontent.com/510004015/Quantumult_X/Remote/Premium/BaiduLibrary.conf",

    "网易云音乐": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/NeteaseMusicVipCrack.js",
    "WPS超级会员Pro": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/WPSuperVIPuserCrack.js",

    "PornHubPremium": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/PornHubPremiumCrack.js",
    "91视频": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/JiuYiPornVideoCrack.js",
    "麻豆社区": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/mdsqallcrack.js",
    "私房TV": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/SecretsMediaCrack.js",
    "欲涩漫": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/PornComicsCrack.js",
    "涩蕉视频": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/PainedBashoCrack.js",
    "悦色视频": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/PleasantVideoCrack.js",
    "逼哩涩漫": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/BiliCartcoonCrack.js",
    "Javbd": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/javbdvipcrack.js",
    "蜜桃传媒": "https://raw.githubusercontent.com/yqc007/QuantumultX/master/PeachMediaYuheng01Crack.js",
}


def load_exclude_domains():
    with open("exclude_domains", 'r', encoding='utf-8') as f:
        content = f.read().splitlines()
    for line in content:
        line = line.strip()
        if len(line) == 0:
            continue
        exclude_domains.append(line)


def gen_dnsmasq(name, dns):
    domains = []

    # 放到data/geosite目录里合并处理
    file_name = "{:s}_domains".format(name)
    shutil.copyfile(file_name, "data/geosite/{:s}".format(file_name))

    q = queue.SimpleQueue()
    q.put("include:{:s}".format(file_name))

    while not q.empty():
        item = q.get()
        is_only_cn = False

        if item.startswith('include:'):
            if item.endswith('@cn'):
                is_only_cn = True
                item = item.replace('@cn', '')

            item_include = item.replace('include:', '')
            item_file = item_include.split('#', 1)[0].rstrip()
            with open("data/geosite/{:s}".format(item_file), 'r', encoding='utf-8') as f:
                content = f.read().splitlines()

            for line in content:
                line = line.strip()
                if len(line) == 0:
                    continue
                elif line.startswith('include:'):
                    if is_only_cn:
                        q.put("{:s}@cn".format(line))
                    else:
                        q.put(line)
                else:
                    if is_only_cn and ('@cn' not in line):
                        continue

                    re_search = domain_pattern.search(line)
                    if re_search:
                        domain = re_search.group()
                        if (domain not in domains) and (domain not in exclude_domains):
                            domains.append("server=/{:s}/{:s}\n".format(domain, dns))

    with open("publish/direct.domains.conf", mode='w', encoding='utf-8') as out_f:
        out_f.writelines(domains)


def gen_clash_providers():
    unban_remove = ["Epicgames", "epicgames", "Google", "google"]

    divide_providers = {}
    for root, dirs, files in os.walk(r"data/acl4ssr"):
        for file in files:
            if os.path.splitext(file)[1] == '.list':
                in_file_path = "{:s}/{:s}".format(root, file).replace('\\', '/')
                out_file_path = "publish/Providers/{:s}".format(
                    in_file_path.replace('data/acl4ssr/', '').replace('.list', '.yaml'))

                provider_out = ["payload:\n"]

                # divide domain and ip
                out_file_path_ip = out_file_path.replace('.yaml', '_IP.yaml')
                divide_providers[out_file_path] = ["payload:\n"]
                divide_providers[out_file_path_ip] = ["payload:\n"]

                with open(in_file_path, 'r', encoding='utf-8') as f:
                    content = f.read().splitlines()
                for line in content:
                    line = line.strip()
                    if len(line) == 0:
                        continue
                    # remove some unban
                    if file == "UnBan.list" and any(key in line for key in unban_remove):
                        continue
                    if line.startswith('#'):
                        provider_out.append("  {:s}\n".format(line))
                        continue
                    if line.split(",")[0] not in clash_support_types:
                        provider_out.append("  # {:s}\n".format(line))
                        continue

                    out_line = "  - {:s}\n".format(line)

                    # divide domain and ip
                    if line.startswith('IP-CIDR') or line.startswith('GEOIP'):
                        # if "no-resolve" not in line:
                        #     out_line = "  - {:s},no-resolve\n".format(line)
                        divide_providers[out_file_path_ip].append(out_line)
                    else:
                        divide_providers[out_file_path].append(out_line)

                    # no divide
                    provider_out.append(out_line)

                with open(out_file_path, mode='w', encoding='utf-8') as out_f:
                    out_f.writelines(provider_out)

    # divide domain and ip
    for divide_provider in divide_providers:
        if len(divide_providers[divide_provider]) > 1:
            with open(divide_provider.replace('/Providers/', '/ProvidersD/'), mode='w', encoding='utf-8') as out_f:
                out_f.writelines(divide_providers[divide_provider])


def gen_mosdns_list(list_urls, out_name):
    mosdns_list = set()
    for list_url in list_urls:
        data = urllib.request.urlopen(list_url).read().decode("utf-8")
        rule_lines = data.splitlines()
        for line in rule_lines:
            line = line.strip()
            line += "\n"
            if line.startswith('DOMAIN,'):
                mosdns_list.add(line.replace('DOMAIN,', 'full:'))
                continue
            if line.startswith('DOMAIN-SUFFIX,'):
                mosdns_list.add(line.replace('DOMAIN-SUFFIX,', 'domain:'))
                continue
            if line.startswith('DOMAIN-KEYWORD,'):
                mosdns_list.add(line.replace('DOMAIN-KEYWORD,', 'keyword:'))
                continue
            if line.startswith('DOMAIN-REGEX,'):
                mosdns_list.add(line.replace('DOMAIN-REGEX,', 'regexp:'))
                continue

    with open("publish/mosdns/{:s}".format(out_name), mode='w', encoding='utf-8') as out_f:
        out_f.writelines(list(mosdns_list))


def quanx_script_2_sgmodule(script_urls):
    for name, script_url in script_urls.items():
        file_name = script_url.split("/")[-1].replace(".js", "").replace(".conf", "")

        rewrite_flag = False
        rewrite_list = []
        mitm_flag = False
        mitm_list = []

        desc = ""

        data = urllib.request.urlopen(script_url).read().decode("utf-8")
        rule_lines = data.splitlines()
        for line in rule_lines:
            line = line.strip()

            # end flag
            if line.endswith("*/"):
                break
            elif line.startswith("*****") or line.startswith("#") or line.isspace() or len(line) == 0:
                continue
            else:
                if line.startswith("脚本功能"):
                    desc = line.replace('脚本功能：', '')
                    continue

                    # reset flag
                if line.startswith("["):
                    rewrite_flag = False
                    mitm_flag = False

                if line == "[rewrite_local]":
                    rewrite_flag = True
                elif line == "[mitm]":
                    mitm_flag = True
                else:
                    if rewrite_flag:
                        rewrite_list.append(line)
                    if mitm_flag:
                        mitm_list.append(line)

        sgmodule_lines = []
        sgmodule_lines.append("#!name={:s}\n".format(name))
        sgmodule_lines.append("#!desc={:s}\n".format(desc))
        sgmodule_lines.append("#!category=chnlist\n")
        sgmodule_lines.append("#!original={:s}\n".format(script_url))
        sgmodule_lines.append("\n")

        rewrite_locals = []
        url_rewrites = []
        map_locals = []
        index = 0
        for rewrite in rewrite_list:
            index += 1
            srcipt_name = "{:s}-{:d}".format(name, index)

            params = rewrite.split()
            if params[2] == ("reject"):
                url_rewrites.append("{:s} _ reject\n".format(params[0]))

            elif params[2] == ("reject-200"):
                rewrite_locals.append(
                    "{:s} = type=http-request,pattern={:s},script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Surge_reject-200.js\n".format(srcipt_name, params[0]))

            elif params[2] == ("reject-img"):
                map_locals.append("{:s} data={:s}\n".format(
                    params[0], "https://raw.githubusercontent.com/alecthw/chnlist/main/blank/blank.gif"))
            elif params[2] == ("reject-array"):
                map_locals.append("{:s} data={:s}\n".format(
                    params[0], "https://raw.githubusercontent.com/alecthw/chnlist/main/blank/blank_array.json"))
            elif params[2] == ("reject-dict"):
                map_locals.append("{:s} data={:s}\n".format(
                    params[0], "https://raw.githubusercontent.com/alecthw/chnlist/main/blank/blank_dict.json"))

            elif params[2] == "script-response-header":
                rewrite_locals.append(
                    "{:s} = type=http-response,pattern={:s},script-path={:s}\n".format(srcipt_name, params[0], params[3]))
            elif params[2] == "script-response-body":
                rewrite_locals.append(
                    "{:s} = type=http-response,pattern={:s},requires-body=1,script-path={:s}\n".format(srcipt_name, params[0], params[3]))

            elif params[2] == "script-request-header":
                rewrite_locals.append(
                    "{:s} = type=http-request,pattern={:s},script-path={:s}\n".format(srcipt_name, params[0], params[3]))
            elif params[2] == "script-request-body":
                rewrite_locals.append(
                    "{:s} = type=http-request,pattern={:s},requires-body=1,script-path={:s}\n".format(srcipt_name, params[0], params[3]))

        if len(url_rewrites) > 0:
            sgmodule_lines.append("[URL Rewrite]\n")
            sgmodule_lines.extend(url_rewrites)
            sgmodule_lines.append("\n")

        if len(rewrite_locals) > 0:
            sgmodule_lines.append("[Script]\n")
            sgmodule_lines.extend(rewrite_locals)
            sgmodule_lines.append("\n")

        if len(map_locals) > 0:
            sgmodule_lines.append("[Map Local]\n")
            sgmodule_lines.extend(map_locals)
            sgmodule_lines.append("\n")

        if len(mitm_list) > 0:
            sgmodule_lines.append("[MITM]\n")
        for mitm in mitm_list:
            params = mitm.split("=")
            key = params[0].strip()
            value = params[1].strip()
            if key == "hostname":
                sgmodule_lines.append("hostname = %APPEND% {:s}\n".format(value))

        with open("publish/sgmodule/{:s}.sgmodule".format(file_name), mode='w', encoding='utf-8') as out_f:
            out_f.writelines(list(sgmodule_lines))


if __name__ == '__main__':
    if not os.path.exists("publish"):
        os.makedirs("publish/Providers/Ruleset")
        os.makedirs("publish/Providers/Custom")
        os.makedirs("publish/ProvidersD/Ruleset")
        os.makedirs("publish/ProvidersD/Custom")
        os.makedirs("publish/mosdns")
        os.makedirs("publish/sgmodule")
    load_exclude_domains()

    #gen_dnsmasq('direct', '223.5.5.5')

    gen_clash_providers()

    gen_mosdns_list(mosdns_whitelist_urls, "whitelist.list")
    gen_mosdns_list(mosdns_blacklist_urls, "blacklist.list")

    quanx_script_2_sgmodule(quanx_script_urls)
