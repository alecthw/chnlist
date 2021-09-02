import base64
import os
import queue
import re
import shutil

domain_pattern = re.compile(r'[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(?:\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+')
exclude_domains = []


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

    # 放到data目录里合并处理
    file_name = "{:s}_domains".format(name)
    shutil.copyfile(file_name, "data/{:s}".format(file_name))

    q = queue.SimpleQueue()
    q.put("include:{:s}".format(file_name))

    while not q.empty():
        item = q.get()
        isOnlyCn = False

        if item.startswith('include:'):
            if item.endswith('@cn'):
                isOnlyCn = True
                item = item.replace('@cn', '')

            item_file = item.replace('include:', '')
            with open("data/{:s}".format(item_file), 'r', encoding='utf-8') as f:
                content = f.read().splitlines()

            for line in content:
                line = line.lstrip()
                if len(line) == 0:
                    continue
                elif line.startswith('include:'):
                    if isOnlyCn:
                        q.put("{:s}@cn".format(line))
                    else:
                        q.put(line)
                else:
                    if isOnlyCn and ('@cn' not in line):
                        continue

                    re_search = domain_pattern.search(line)
                    if re_search:
                        domain = re_search.group()
                        if (domain not in domains) and (domain not in exclude_domains):
                            domains.append("server=/{:s}/{:s}\n".format(domain, dns))

    with open("direct.domains.conf", mode='w', encoding='utf-8') as out_f:
        out_f.writelines(domains)


if __name__ == '__main__':
    load_exclude_domains()
    gen_dnsmasq('direct', '114.114.114.114')
