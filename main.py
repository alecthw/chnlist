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
    # "MATCH"
]

clash_ip_types = [
    "GEOIP",
    "IP-CIDR",
    "IP-CIDR6"
]


def load_exclude_domains():
    with open("exclude_domains", 'r', encoding='utf-8') as f:
        content = f.read().splitlines()
    for line in content:
        line = line.lstrip()
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

            item_file = item.replace('include:', '')
            with open("data/geosite/{:s}".format(item_file), 'r', encoding='utf-8') as f:
                content = f.read().splitlines()

            for line in content:
                line = line.lstrip()
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
                    line = line.lstrip()
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
                        if "no-resolve" not in line:
                            out_line = "  - {:s},no-resolve\n".format(line)
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


def gen_mosdns_whitelist():
    whitelist_urls = [
        "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Direct/Direct.list",
        "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Download/Download.list",
        "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Game/GameDownloadCN/GameDownloadCN.list",
        "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Game/GameDownload/GameDownload.list"
    ]

    mosdns_whitelist = []
    for whitelist_url in whitelist_urls:
        data = urllib.request.urlopen(whitelist_url).read().decode("utf-8")
        rule_lines = data.splitlines()
        for line in rule_lines:
            line = line.lstrip()
            if line.startswith('DOMAIN'):
                mosdns_whitelist.append(line.replace('DOMAIN,', 'full:'))
                continue
            if line.startswith('DOMAIN-SUFFIX'):
               mosdns_whitelist.append(line.replace('DOMAIN-SUFFIX,', 'domain:'))
               continue
            if line.startswith('DOMAIN-KEYWORD'):
               mosdns_whitelist.append(line.replace('DOMAIN-KEYWORD,', 'keyword:'))
               continue

    with open("publish/mosdns/whitelist.list", mode='w', encoding='utf-8') as out_f:
        out_f.writelines(mosdns_whitelist)




if __name__ == '__main__':
    if not os.path.exists("publish"):
        os.makedirs("publish/Providers/Ruleset")
        os.makedirs("publish/Providers/Custom")
        os.makedirs("publish/ProvidersD/Ruleset")
        os.makedirs("publish/ProvidersD/Custom")
        os.makedirs("publish/mosdns")
    load_exclude_domains()
    gen_dnsmasq('direct', '223.5.5.5')
    gen_clash_providers()
    gen_mosdns_whitelist()
